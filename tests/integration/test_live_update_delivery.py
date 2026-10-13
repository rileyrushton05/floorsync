"""The API half of live delivery, end to end against a real PostgreSQL (#148).

The unit tests in `tests/backend` fake the session, and a fake session cannot reproduce the thing
that bit the first version of `OutboxPublisher`: sessions here are `autobegin=False`, so any
statement run outside an explicit `begin()` raises, and the publisher runs right after the route's
own transaction has closed. These tests send a real request through the real route and the real
publisher and relay, with only Redis faked (a real Redis is covered by
`test_live_update_cross_instance.py`).
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from database_support import Sessions, run, transaction
from fastapi.testclient import TestClient
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from test_live_update_outbox import (
    a_confirmed_schedule_with_a_simulation,
    counts,
    outbox_rows,
)

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_api.features.live_updates import delivery as delivery_module
from floorsync_api.features.live_updates import outbox_relay as relay_module
from floorsync_api.features.live_updates import publisher as publisher_module
from floorsync_api.features.live_updates.outbox_relay import BASE_BACKOFF_SECONDS, OutboxRelay
from floorsync_api.main import application
from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox
from floorsync_common.database.models.user import User
from floorsync_common.live_updates.service import LiveUpdateOutboxService


class FakeRedis:
    def __init__(self) -> None:
        self.down = False
        self.published: list[str] = []

    async def publish(self, _channel: str, message: str) -> None:
        if self.down:
            raise RedisError("Redis is unreachable.")
        self.published.append(message)


@pytest.fixture
def redis(monkeypatch: pytest.MonkeyPatch) -> FakeRedis:
    fake = FakeRedis()
    monkeypatch.setattr(delivery_module, "get_redis_client", lambda: fake)
    monkeypatch.setattr(delivery_module, "get_redis_client", lambda: fake)
    return fake


@pytest.fixture
def api(database_url: str, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """The real app, its sessions bound to the test database and its caller a signed-in manager."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    engine = create_async_engine(database_url, poolclass=NullPool)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autobegin=False)

    async def db_session() -> AsyncIterator[Any]:
        async with sessions() as session:
            yield session

    async def manager() -> User:
        return User(id=uuid4(), name="Manager", role="manager")

    @contextlib.asynccontextmanager
    async def publisher_session_scope() -> AsyncIterator[Any]:
        async with sessions() as session, session.begin():
            yield session

    monkeypatch.setattr(publisher_module, "session_scope", publisher_session_scope)
    application.dependency_overrides[get_db_session] = db_session
    application.dependency_overrides[get_current_user] = manager
    try:
        yield TestClient(application)
    finally:
        application.dependency_overrides.clear()


def _use_database_for_relay(monkeypatch: pytest.MonkeyPatch, sessions: Sessions) -> None:
    @contextlib.asynccontextmanager
    async def session_scope() -> AsyncIterator[Any]:
        async with transaction(sessions) as db:
            yield db

    monkeypatch.setattr(relay_module, "session_scope", session_scope)


def _start(client: TestClient, simulation_id: UUID) -> Any:
    return client.post(
        f"/api/v1/simulations/{simulation_id}/events",
        json={"event_type": "started", "speed": "1"},
    )


def _only_row(sessions: Sessions, simulation_id: UUID) -> Any:
    async def read() -> LiveUpdateOutbox:
        async with transaction(sessions) as db:
            row = await db.scalar(
                select(LiveUpdateOutbox).where(LiveUpdateOutbox.aggregate_id == simulation_id)
            )
        assert row is not None
        return row

    return read()


# -- the route and the immediate publisher ---------------------------------------------------


def test_a_control_is_committed_published_and_marked_published(
    database_url: str, api: TestClient, redis: FakeRedis
) -> None:
    async def prepare(sessions: Sessions) -> UUID:
        return await a_confirmed_schedule_with_a_simulation(sessions)

    simulation_id = run(database_url, prepare)

    response = _start(api, simulation_id)

    assert response.status_code == 201

    async def check(sessions: Sessions) -> None:
        assert await counts(sessions, simulation_id) == (1, 1, 1)
        row = await _only_row(sessions, simulation_id)
        assert row.published_at is not None  # publish_now's own read and write both ran
        assert redis.published == [json.dumps(row.payload)]
        assert row.payload["cause"] == "started"
        assert row.payload["sequence"] == 1

    run(database_url, check)


def test_a_control_still_succeeds_when_redis_is_down_and_the_row_waits(
    database_url: str, api: TestClient, redis: FakeRedis
) -> None:
    simulation_id = run(database_url, a_confirmed_schedule_with_a_simulation)
    redis.down = True

    response = _start(api, simulation_id)

    assert response.status_code == 201

    async def check(sessions: Sessions) -> None:
        assert await counts(sessions, simulation_id) == (1, 1, 1)
        assert (await _only_row(sessions, simulation_id)).published_at is None

    run(database_url, check)


def test_a_refused_control_writes_nothing_and_publishes_nothing(
    database_url: str, api: TestClient, redis: FakeRedis
) -> None:
    simulation_id = run(database_url, a_confirmed_schedule_with_a_simulation)

    # Pausing a simulation that was never started is not applicable.
    response = api.post(
        f"/api/v1/simulations/{simulation_id}/events", json={"event_type": "paused"}
    )

    assert response.status_code == 409
    assert redis.published == []

    async def check(sessions: Sessions) -> None:
        assert await counts(sessions, simulation_id) == (0, 0, 0)

    run(database_url, check)


def test_a_database_failure_after_commit_does_not_fail_the_control_and_the_relay_recovers(
    database_url: str, api: TestClient, redis: FakeRedis, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The control committed; if marking the row published then fails, the caller must still get
    the committed result, and the row (already sent once) is left for the relay."""

    simulation_id = run(database_url, a_confirmed_schedule_with_a_simulation)

    async def broken(*_: object, **__: object) -> None:
        raise OperationalError("UPDATE", {}, Exception("connection lost"))

    with monkeypatch.context() as patched:
        patched.setattr(LiveUpdateOutboxService, "mark_published", staticmethod(broken))
        response = _start(api, simulation_id)

    assert response.status_code == 201
    assert len(redis.published) == 1  # it did reach Redis; only the bookkeeping failed

    async def body(sessions: Sessions) -> None:
        assert await counts(sessions, simulation_id) == (1, 1, 1)
        assert (await _only_row(sessions, simulation_id)).published_at is None
        _use_database_for_relay(monkeypatch, sessions)

        assert await OutboxRelay().run_once() == 1  # the relay settles it

        assert (await _only_row(sessions, simulation_id)).published_at is not None

    run(database_url, body)


# -- the relay ---------------------------------------------------------------------------------


def test_the_relay_publishes_a_row_the_immediate_publish_missed(
    database_url: str, api: TestClient, redis: FakeRedis, monkeypatch: pytest.MonkeyPatch
) -> None:
    simulation_id = run(database_url, a_confirmed_schedule_with_a_simulation)
    redis.down = True
    assert _start(api, simulation_id).status_code == 201
    redis.down = False

    async def body(sessions: Sessions) -> None:
        _use_database_for_relay(monkeypatch, sessions)

        claimed = await OutboxRelay().run_once()

        assert claimed == 1
        row = await _only_row(sessions, simulation_id)
        assert row.published_at is not None
        assert redis.published == [json.dumps(row.payload)]
        assert await OutboxRelay().run_once() == 0  # nothing left owed

    run(database_url, body)


def test_the_relay_holds_a_failing_row_back_until_its_retry_time(
    database_url: str, api: TestClient, redis: FakeRedis, monkeypatch: pytest.MonkeyPatch
) -> None:
    simulation_id = run(database_url, a_confirmed_schedule_with_a_simulation)
    redis.down = True
    assert _start(api, simulation_id).status_code == 201

    async def body(sessions: Sessions) -> None:
        _use_database_for_relay(monkeypatch, sessions)
        before = datetime.now(UTC)

        assert await OutboxRelay().run_once() == 1

        row = await _only_row(sessions, simulation_id)
        assert row.published_at is None
        assert row.attempt_count == 1
        assert row.last_error_code == "RedisError"
        assert row.next_attempt_at >= before + timedelta(seconds=BASE_BACKOFF_SECONDS)
        assert await OutboxRelay().run_once() == 0  # not due yet, so not claimed again

    run(database_url, body)


def test_the_relay_parks_an_unreadable_row_instead_of_publishing_it(
    database_url: str, redis: FakeRedis, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def body(sessions: Sessions) -> None:
        _use_database_for_relay(monkeypatch, sessions)
        [outbox_id] = await outbox_rows(sessions, datetime.now(UTC) - timedelta(seconds=1))

        assert await OutboxRelay().run_once() == 1

        async with transaction(sessions) as db:
            row = await db.get(LiveUpdateOutbox, outbox_id)
        assert row is not None
        assert row.published_at is None
        assert row.last_error_code == "UnsupportedEnvelope"
        assert row.attempt_count == 1
        assert redis.published == []  # a payload every subscriber would drop is never sent

    run(database_url, body)
