"""A readiness signal for live delivery, separate from the API's own `/health/ready` (#148).

Redis being down must never make the REST API unready (decision 0017): a control is still recorded,
just without a live push. So this is its own probe, for alerting on live delivery, not a traffic
gate.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final, Protocol, assert_never

from redis.exceptions import RedisError

from floorsync_api.features.live_updates.connection_hub import ConnectionHub
from floorsync_api.features.live_updates.redis_client import get_redis_client
from floorsync_common.database.session import session_scope
from floorsync_common.live_updates.service import LiveUpdateOutboxService
from floorsync_common.settings import settings

# Above this, an unpublished row is not "mid-retry" any more -- something is actually stuck (the
# relay is wedged, or Redis has been down long enough that this deserves its own alert).
DEGRADED_BACKLOG_AGE_SECONDS: Final = 120.0


class _RunsInBackground(Protocol):
    """What this module needs from the subscriber and the relay: are they still running."""

    @property
    def running(self) -> bool: ...


class _Subscriber(_RunsInBackground, Protocol):
    @property
    def dropped_payloads(self) -> int: ...


@dataclass(frozen=True, slots=True)
class BacklogMeasured:
    unpublished_count: int
    oldest_age_seconds: float | None


@dataclass(frozen=True, slots=True)
class BacklogUnavailable:
    """The database could not be asked: it is down, or slower than the readiness timeout."""


type BacklogReading = BacklogMeasured | BacklogUnavailable


@dataclass(frozen=True, slots=True)
class LiveUpdateHealthReport:
    """`unpublished_outbox_count` and `oldest_unpublished_age_seconds` are `None` when
    `outbox_available` is false: nothing was measured, so nothing is reported."""

    status: str
    redis_reachable: bool
    subscriber_running: bool
    relay_running: bool
    active_sockets: int
    active_subscriptions: int
    outbox_available: bool
    unpublished_outbox_count: int | None
    oldest_unpublished_age_seconds: float | None
    dropped_invalid_payloads: int


async def build_report(
    *, subscriber: _Subscriber, relay: _RunsInBackground, hub: ConnectionHub
) -> LiveUpdateHealthReport:
    redis_reachable = await _redis_reachable()
    reading = await _outbox_backlog()

    count: int | None
    oldest_age: float | None
    match reading:
        case BacklogMeasured(unpublished_count=count, oldest_age_seconds=oldest_age):
            outbox_available = True
            backlog_stuck = oldest_age is not None and oldest_age > DEGRADED_BACKLOG_AGE_SECONDS
        case BacklogUnavailable():
            outbox_available = False
            count, oldest_age = None, None
            backlog_stuck = False
        case _:
            assert_never(reading)

    degraded = (
        not redis_reachable
        or not subscriber.running
        or not relay.running
        or not outbox_available
        or backlog_stuck
    )
    return LiveUpdateHealthReport(
        status="degraded" if degraded else "ok",
        redis_reachable=redis_reachable,
        subscriber_running=subscriber.running,
        relay_running=relay.running,
        active_sockets=hub.socket_count(),
        active_subscriptions=hub.subscription_count(),
        outbox_available=outbox_available,
        unpublished_outbox_count=count,
        oldest_unpublished_age_seconds=oldest_age,
        dropped_invalid_payloads=subscriber.dropped_payloads,
    )


async def _redis_reachable() -> bool:
    try:
        async with asyncio.timeout(settings.readiness_timeout_seconds):
            await get_redis_client().ping()
    except (RedisError, TimeoutError, OSError):
        return False
    return True


async def _outbox_backlog() -> BacklogReading:
    try:
        async with asyncio.timeout(settings.readiness_timeout_seconds):
            async with session_scope() as db:
                backlog = await LiveUpdateOutboxService.backlog(db)
    except Exception:
        return BacklogUnavailable()
    if backlog.oldest_created_at is None:
        return BacklogMeasured(unpublished_count=backlog.unpublished_count, oldest_age_seconds=None)
    age = (datetime.now(UTC) - backlog.oldest_created_at).total_seconds()
    return BacklogMeasured(unpublished_count=backlog.unpublished_count, oldest_age_seconds=age)


__all__ = ["DEGRADED_BACKLOG_AGE_SECONDS", "LiveUpdateHealthReport", "build_report"]
