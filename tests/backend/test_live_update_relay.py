"""The outbox relay (#148): retrying a row immediate publish missed.

The relay holds Redis and timing but no SQL, so `LiveUpdateOutboxService`'s relay methods are
stubbed here (the real claim/settle SQL is proven against Postgres in `tests/integration`) and
`session_scope` is faked; what these tests prove is which rows get published or held back, and how
far.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from live_update_payloads import valid_payload
from redis.exceptions import RedisError

from floorsync_api.features.live_updates import outbox_relay as relay_module
from floorsync_api.features.live_updates.outbox_relay import (
    BASE_BACKOFF_SECONDS,
    BATCH_SIZE,
    MAX_BACKOFF_SECONDS,
    OutboxRelay,
    _backoff,
)
from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox
from floorsync_common.live_updates.results import OutboxRowPublished
from floorsync_common.live_updates.service import LiveUpdateOutboxService

NOW = datetime(2026, 9, 18, 12, 0, tzinfo=UTC)


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def _row(
    *,
    published_at: datetime | None = None,
    attempt_count: int = 0,
    next_attempt_at: datetime = NOW,
    payload: dict[str, Any] | None = None,
) -> LiveUpdateOutbox:
    return LiveUpdateOutbox(
        id=uuid4(),
        topic="simulation.changed",
        aggregate_id=uuid4(),
        sequence=1,
        payload=payload if payload is not None else valid_payload(),
        published_at=published_at,
        attempt_count=attempt_count,
        next_attempt_at=next_attempt_at,
        last_error_code=None,
    )


class FakeSession:
    """`session_scope` yields this; the service methods are stubbed, so it is never queried."""


class RecordedOutbox:
    """Stands in for `LiveUpdateOutboxService`'s relay methods and records how they were called."""

    def __init__(self, rows: list[LiveUpdateOutbox]) -> None:
        self.rows = rows
        self.claimed_with: dict[str, Any] = {}
        self.published: list[UUID] = []
        self.failures: list[dict[str, Any]] = []

    async def claim_due(self, _db: Any, *, now: datetime, limit: int) -> list[LiveUpdateOutbox]:
        self.claimed_with = {"now": now, "limit": limit}
        return self.rows

    async def mark_published(self, _db: Any, outbox_id: UUID, *, at: datetime) -> Any:
        self.published.append(outbox_id)
        return OutboxRowPublished(outbox_id=outbox_id)

    async def record_failure(
        self, _db: Any, outbox_id: UUID, *, error_code: str, retry_at: datetime
    ) -> None:
        self.failures.append({"id": outbox_id, "error_code": error_code, "retry_at": retry_at})


def _stub_outbox(monkeypatch: pytest.MonkeyPatch, rows: list[LiveUpdateOutbox]) -> RecordedOutbox:
    @contextlib.asynccontextmanager
    async def fake_session_scope() -> Any:
        yield FakeSession()

    outbox = RecordedOutbox(rows)
    monkeypatch.setattr(relay_module, "session_scope", fake_session_scope)
    monkeypatch.setattr(LiveUpdateOutboxService, "claim_due", staticmethod(outbox.claim_due))
    monkeypatch.setattr(
        LiveUpdateOutboxService, "mark_published", staticmethod(outbox.mark_published)
    )
    monkeypatch.setattr(
        LiveUpdateOutboxService, "record_failure", staticmethod(outbox.record_failure)
    )
    return outbox


class FakeRedis:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.published: list[tuple[str, str]] = []

    async def publish(self, channel: str, message: str) -> None:
        if self.fail:
            raise RedisError("Redis is unreachable.")
        self.published.append((channel, message))


def _stub_redis(monkeypatch: pytest.MonkeyPatch, redis: FakeRedis) -> None:
    monkeypatch.setattr(relay_module, "get_redis_client", lambda: redis)


# -- run_once ---------------------------------------------------------------------------------


def test_run_once_publishes_and_marks_a_due_row_published(monkeypatch: pytest.MonkeyPatch) -> None:
    row = _row()
    outbox = _stub_outbox(monkeypatch, [row])
    redis = FakeRedis()
    _stub_redis(monkeypatch, redis)

    claimed = run(OutboxRelay().run_once())

    assert claimed == 1
    assert redis.published == [("floorsync.live.simulation.changed", json.dumps(row.payload))]
    assert outbox.published == [row.id]
    assert outbox.failures == []
    assert outbox.claimed_with["limit"] == BATCH_SIZE


def test_run_once_backs_off_a_row_that_still_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    row = _row(attempt_count=2)
    outbox = _stub_outbox(monkeypatch, [row])
    _stub_redis(monkeypatch, FakeRedis(fail=True))

    before = datetime.now(UTC)
    claimed = run(OutboxRelay().run_once())

    assert claimed == 1
    assert outbox.published == []
    [failure] = outbox.failures
    assert failure["id"] == row.id
    assert failure["error_code"] == "RedisError"
    # attempt 3 backs off BASE_BACKOFF_SECONDS * 2**2 seconds from real wall-clock time, not `NOW`
    # (a fixed fixture constant, unrelated to what `datetime.now(UTC)` returns in the sandbox).
    assert before + timedelta(seconds=BASE_BACKOFF_SECONDS * 4) <= failure["retry_at"]


def test_run_once_stops_the_batch_at_the_first_redis_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Redis is down for every row, so trying the rest would only wait out a timeout per row while
    holding their locks. They are left untouched for the next pass."""

    failing_row, untouched_row = _row(), _row()
    outbox = _stub_outbox(monkeypatch, [failing_row, untouched_row])
    redis = FakeRedis(fail=True)
    _stub_redis(monkeypatch, redis)

    handled = run(OutboxRelay().run_once())

    assert handled == 1
    assert [f["id"] for f in outbox.failures] == [failing_row.id]
    assert outbox.published == []


def test_run_once_carries_on_past_an_unreadable_row(monkeypatch: pytest.MonkeyPatch) -> None:
    """A malformed payload is that row's problem, not Redis's, so the next row is still sent."""

    unreadable, good = _row(payload={"v": 999}), _row()
    outbox = _stub_outbox(monkeypatch, [unreadable, good])
    redis = FakeRedis()
    _stub_redis(monkeypatch, redis)

    handled = run(OutboxRelay().run_once())

    assert handled == 2
    assert [f["id"] for f in outbox.failures] == [unreadable.id]
    assert outbox.published == [good.id]


def test_run_once_parks_an_unreadable_row_instead_of_publishing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = _row(payload={"v": 999})
    outbox = _stub_outbox(monkeypatch, [row])
    redis = FakeRedis()
    _stub_redis(monkeypatch, redis)

    before = datetime.now(UTC)
    run(OutboxRelay().run_once())

    assert redis.published == []
    assert outbox.published == []
    [failure] = outbox.failures
    assert failure["error_code"] == "UnsupportedEnvelope"
    # Retrying cannot fix it, so it waits the longest backoff rather than the next poll.
    assert failure["retry_at"] >= before + timedelta(seconds=MAX_BACKOFF_SECONDS)


def test_run_once_with_nothing_due_claims_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    outbox = _stub_outbox(monkeypatch, [])
    _stub_redis(monkeypatch, FakeRedis())

    claimed = run(OutboxRelay().run_once())

    assert claimed == 0
    assert outbox.published == [] and outbox.failures == []


# -- backoff ------------------------------------------------------------------------------------


def test_backoff_doubles_with_each_attempt() -> None:
    assert _backoff(1) == timedelta(seconds=BASE_BACKOFF_SECONDS)
    assert _backoff(2) == timedelta(seconds=BASE_BACKOFF_SECONDS * 2)
    assert _backoff(3) == timedelta(seconds=BASE_BACKOFF_SECONDS * 4)


def test_backoff_is_capped() -> None:
    assert _backoff(20) == timedelta(seconds=MAX_BACKOFF_SECONDS)


# -- start/stop lifecycle ---------------------------------------------------------------------


def test_stop_before_start_is_a_noop() -> None:
    run(OutboxRelay().stop())  # must not raise


def test_start_then_stop_cancels_the_background_task(monkeypatch: pytest.MonkeyPatch) -> None:
    running = asyncio.Event()

    async def fake_run_forever(self: OutboxRelay) -> None:
        running.set()
        await asyncio.Event().wait()  # blocks until cancelled

    monkeypatch.setattr(OutboxRelay, "_run_forever", fake_run_forever)

    async def scenario() -> None:
        relay = OutboxRelay()
        relay.start()
        await running.wait()
        await relay.stop()
        assert relay._task is None

    run(scenario())


def test_starting_twice_does_not_replace_the_running_task(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_run_forever(self: OutboxRelay) -> None:
        await asyncio.Event().wait()

    monkeypatch.setattr(OutboxRelay, "_run_forever", fake_run_forever)

    async def scenario() -> None:
        relay = OutboxRelay()
        relay.start()
        first_task = relay._task
        relay.start()
        assert relay._task is first_task
        await relay.stop()

    run(scenario())
