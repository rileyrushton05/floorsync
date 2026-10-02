"""The live-update readiness signal (#148): a probe independent of `/health/ready`.

Neither Redis nor the database is reachable in this suite (confirmed elsewhere in this session),
so both are stubbed: a fake Redis client for `ping`, and `LiveUpdateOutboxService.backlog` returning
a canned `OutboxBacklog` (the real query is proven against Postgres in `tests/integration`).
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from redis.exceptions import RedisError

from floorsync_api.features.live_updates import health as health_module
from floorsync_api.features.live_updates.connection_hub import ConnectionHub, SubscriptionKey
from floorsync_api.features.live_updates.health import DEGRADED_BACKLOG_AGE_SECONDS, build_report
from floorsync_common.live_updates.results import OutboxBacklog
from floorsync_common.live_updates.service import LiveUpdateOutboxService


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


class FakeProcess:
    def __init__(self, *, running: bool) -> None:
        self.running = running


class FakeRedis:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail

    async def ping(self) -> None:
        if self.fail:
            raise RedisError("Redis is unreachable.")


class FakeSession:
    """`session_scope` yields this; `LiveUpdateOutboxService.backlog` is stubbed, never queried."""


def _stub(
    monkeypatch: pytest.MonkeyPatch,
    *,
    redis_fails: bool = False,
    outbox_row: tuple[int, datetime | None] = (0, None),
) -> None:
    monkeypatch.setattr(health_module, "get_redis_client", lambda: FakeRedis(fail=redis_fails))

    @contextlib.asynccontextmanager
    async def fake_session_scope() -> Any:
        yield FakeSession()

    async def fake_backlog(_db: Any) -> OutboxBacklog:
        count, oldest = outbox_row
        return OutboxBacklog(unpublished_count=count, oldest_created_at=oldest)

    monkeypatch.setattr(health_module, "session_scope", fake_session_scope)
    monkeypatch.setattr(LiveUpdateOutboxService, "backlog", staticmethod(fake_backlog))


def _build(
    monkeypatch: pytest.MonkeyPatch,
    *,
    redis_fails: bool = False,
    subscriber_running: bool = True,
    relay_running: bool = True,
    outbox_row: tuple[int, datetime | None] = (0, None),
    hub: ConnectionHub | None = None,
) -> health_module.LiveUpdateHealthReport:
    _stub(monkeypatch, redis_fails=redis_fails, outbox_row=outbox_row)
    return run(
        build_report(
            subscriber=FakeProcess(running=subscriber_running),
            relay=FakeProcess(running=relay_running),
            hub=hub if hub is not None else ConnectionHub(),
        )
    )


def test_reports_ok_when_everything_is_healthy(monkeypatch: pytest.MonkeyPatch) -> None:
    report = _build(monkeypatch)

    assert report.status == "ok"
    assert report.redis_reachable is True
    assert report.subscriber_running is True
    assert report.relay_running is True
    assert report.unpublished_outbox_count == 0
    assert report.oldest_unpublished_age_seconds is None


def test_degraded_when_redis_is_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    report = _build(monkeypatch, redis_fails=True)

    assert report.status == "degraded"
    assert report.redis_reachable is False


def test_degraded_when_the_subscriber_is_not_running(monkeypatch: pytest.MonkeyPatch) -> None:
    report = _build(monkeypatch, subscriber_running=False)

    assert report.status == "degraded"


def test_degraded_when_the_relay_is_not_running(monkeypatch: pytest.MonkeyPatch) -> None:
    report = _build(monkeypatch, relay_running=False)

    assert report.status == "degraded"


def test_ok_with_a_fresh_unpublished_row(monkeypatch: pytest.MonkeyPatch) -> None:
    fresh = datetime.now(UTC) - timedelta(seconds=5)

    report = _build(monkeypatch, outbox_row=(1, fresh))

    assert report.status == "ok"
    assert report.unpublished_outbox_count == 1
    assert report.oldest_unpublished_age_seconds == pytest.approx(5, abs=1)


def test_degraded_when_the_backlog_is_stale(monkeypatch: pytest.MonkeyPatch) -> None:
    stale = datetime.now(UTC) - timedelta(seconds=DEGRADED_BACKLOG_AGE_SECONDS + 30)

    report = _build(monkeypatch, outbox_row=(3, stale))

    assert report.status == "degraded"
    assert report.unpublished_outbox_count == 3


def test_reports_the_hubs_socket_and_subscription_gauges(monkeypatch: pytest.MonkeyPatch) -> None:
    hub = ConnectionHub()

    class FakeSocket:
        async def send_json(self, _data: Any) -> None:
            return None

    socket = FakeSocket()
    hub.register(SubscriptionKey(simulation_id=uuid4(), audience="manager_floor"), socket)

    report = _build(monkeypatch, hub=hub)

    assert report.active_sockets == 1
    assert report.active_subscriptions == 1
