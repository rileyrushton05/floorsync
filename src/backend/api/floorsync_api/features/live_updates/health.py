"""A readiness signal for live delivery, separate from the API's own `/health/ready` (#148).

Per decision 0017 and the observability conventions, Redis being down must never make the REST
API unready -- a control still gets recorded, just without a live push. So this cannot live inside
`/health/ready`: it is its own probe, for whoever wants to alert on live delivery specifically
(the two boxes it does not affect: normal request handling, and the outbox's own durability).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final, Protocol

from redis.exceptions import RedisError
from sqlalchemy import func, select

from floorsync_api.features.live_updates.connection_hub import ConnectionHub
from floorsync_api.features.live_updates.redis_client import get_redis_client
from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox
from floorsync_common.database.session import session_scope
from floorsync_common.settings import settings

# Above this, an unpublished row is not "mid-retry" any more -- something is actually stuck (the
# relay is wedged, or Redis has been down long enough that this deserves its own alert).
DEGRADED_BACKLOG_AGE_SECONDS: Final = 120.0


class _RunsInBackground(Protocol):
    """What this module needs from the subscriber and the relay: are they still running."""

    @property
    def running(self) -> bool: ...


@dataclass(frozen=True, slots=True)
class LiveUpdateHealthReport:
    status: str
    redis_reachable: bool
    subscriber_running: bool
    relay_running: bool
    active_sockets: int
    active_subscriptions: int
    unpublished_outbox_count: int
    oldest_unpublished_age_seconds: float | None


async def build_report(
    *, subscriber: _RunsInBackground, relay: _RunsInBackground, hub: ConnectionHub
) -> LiveUpdateHealthReport:
    redis_reachable = await _redis_reachable()
    outbox_count, oldest_age = await _outbox_backlog()

    degraded = (
        not redis_reachable
        or not subscriber.running
        or not relay.running
        or (oldest_age is not None and oldest_age > DEGRADED_BACKLOG_AGE_SECONDS)
    )
    return LiveUpdateHealthReport(
        status="degraded" if degraded else "ok",
        redis_reachable=redis_reachable,
        subscriber_running=subscriber.running,
        relay_running=relay.running,
        active_sockets=hub.socket_count(),
        active_subscriptions=hub.subscription_count(),
        unpublished_outbox_count=outbox_count,
        oldest_unpublished_age_seconds=oldest_age,
    )


async def _redis_reachable() -> bool:
    try:
        async with asyncio.timeout(settings.readiness_timeout_seconds):
            await get_redis_client().ping()
    except (RedisError, TimeoutError, OSError):
        return False
    return True


async def _outbox_backlog() -> tuple[int, float | None]:
    """`(unpublished row count, age in seconds of the oldest one)`, or `(0, None)` if empty."""
    try:
        async with asyncio.timeout(settings.readiness_timeout_seconds):
            async with session_scope() as db:
                count, oldest_created_at = (
                    await db.execute(
                        select(func.count(), func.min(LiveUpdateOutbox.created_at)).where(
                            LiveUpdateOutbox.published_at.is_(None)
                        )
                    )
                ).one()
    except Exception:
        # Treat "couldn't even check" the same as "found a very old row": both mean this signal
        # cannot vouch for the backlog right now, which is itself worth surfacing as degraded.
        return 0, DEGRADED_BACKLOG_AGE_SECONDS + 1
    if oldest_created_at is None:
        return count, None
    return count, (datetime.now(UTC) - oldest_created_at).total_seconds()


__all__ = ["DEGRADED_BACKLOG_AGE_SECONDS", "LiveUpdateHealthReport", "build_report"]
