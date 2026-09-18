"""The outbox relay (#148): retrying a row immediate publish missed.

`session_scope` opens a real database connection, unavailable in this suite (confirmed directly
elsewhere in this session: the default `redis_url`/`database_url` hostnames resolve only inside
docker-compose) -- so `run_once` is exercised against a fake session whose `.scalars(...)` returns
real `LiveUpdateOutbox` instances, which is enough to prove the retry/backoff logic without a
database, matching how `test_live_updates.py` exercises `LiveUpdateOutboxService` the same way.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from redis.exceptions import RedisError

from floorsync_api.features.live_updates import outbox_relay as relay_module
from floorsync_api.features.live_updates.outbox_relay import (
    BASE_BACKOFF_SECONDS,
    MAX_BACKOFF_SECONDS,
    OutboxRelay,
    _backoff,
)
from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox

NOW = datetime(2026, 9, 18, 12, 0, tzinfo=UTC)


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def _row(
    *,
    published_at: datetime | None = None,
    attempt_count: int = 0,
    next_attempt_at: datetime = NOW,
) -> LiveUpdateOutbox:
    return LiveUpdateOutbox(
        id=uuid4(),
        topic="simulation.changed",
        aggregate_id=uuid4(),
        sequence=1,
        payload={"v": 1},
        published_at=published_at,
        attempt_count=attempt_count,
        next_attempt_at=next_attempt_at,
        last_error_code=None,
    )


class FakeScalars:
    def __init__(self, rows: list[LiveUpdateOutbox]) -> None:
        self._rows = rows

    def all(self) -> list[LiveUpdateOutbox]:
        return self._rows


class FakeSession:
    def __init__(self, rows: list[LiveUpdateOutbox]) -> None:
        self._rows = rows

    async def scalars(self, _statement: Any) -> FakeScalars:
        return FakeScalars(self._rows)


def _stub_session_scope(monkeypatch: pytest.MonkeyPatch, rows: list[LiveUpdateOutbox]) -> None:
    @contextlib.asynccontextmanager
    async def fake_session_scope() -> Any:
        yield FakeSession(rows)

    monkeypatch.setattr(relay_module, "session_scope", fake_session_scope)


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
    _stub_session_scope(monkeypatch, [row])
    _stub_redis(monkeypatch, FakeRedis())

    claimed = run(OutboxRelay().run_once())

    assert claimed == 1
    assert row.published_at is not None
    assert row.attempt_count == 0


def test_run_once_backs_off_a_row_that_still_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    row = _row(attempt_count=2)
    _stub_session_scope(monkeypatch, [row])
    _stub_redis(monkeypatch, FakeRedis(fail=True))

    before = datetime.now(UTC)
    claimed = run(OutboxRelay().run_once())

    assert claimed == 1
    assert row.published_at is None
    assert row.attempt_count == 3
    assert row.last_error_code == "RedisError"
    # attempt 3 backs off BASE_BACKOFF_SECONDS * 2**2 seconds from real wall-clock time, not `NOW`
    # (a fixed fixture constant, unrelated to what `datetime.now(UTC)` returns in the sandbox).
    assert before + timedelta(seconds=BASE_BACKOFF_SECONDS * 4) <= row.next_attempt_at


def test_run_once_processes_every_row_even_when_one_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One bad row must not stop the batch -- see the ticket's own error contract for the relay."""

    ok_row, failing_row = _row(), _row()
    call_count = 0

    class SometimesFailingRedis:
        async def publish(self, _channel: str, _message: str) -> None:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RedisError("down")

    _stub_session_scope(monkeypatch, [failing_row, ok_row])
    monkeypatch.setattr(relay_module, "get_redis_client", lambda: SometimesFailingRedis())

    claimed = run(OutboxRelay().run_once())

    assert claimed == 2
    assert failing_row.published_at is None
    assert ok_row.published_at is not None


def test_run_once_with_nothing_due_claims_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_session_scope(monkeypatch, [])
    _stub_redis(monkeypatch, FakeRedis())

    claimed = run(OutboxRelay().run_once())

    assert claimed == 0


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
