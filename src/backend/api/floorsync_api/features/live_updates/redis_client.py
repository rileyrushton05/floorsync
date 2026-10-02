"""This API process's Redis connection for live-update delivery.

Direct `redis-py` usage, deliberately not Celery's broker connection -- the live channel must stay
independent of task-queue configuration. Redis database 0; Celery stays on database 1 (see
`docs/decisions/0017-live-update-outbox.md`).
"""

from __future__ import annotations

from redis.asyncio import Redis

from floorsync_common.settings import settings

SIMULATION_CHANGED_CHANNEL = f"{settings.live_update_channel_prefix}.simulation.changed"
"""The one Redis channel this ticket publishes on today; the prefix is configurable so two
environments sharing one Redis never hear each other."""

_client: Redis | None = None


def get_redis_client() -> Redis:
    """Return this process's shared Redis connection, creating it on first use."""
    global _client
    if _client is None:
        _client = Redis.from_url(settings.redis_url)
    return _client


async def close_redis_client() -> None:
    """Release the shared connection. Called from the app's lifespan shutdown."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


__all__ = ["SIMULATION_CHANGED_CHANNEL", "close_redis_client", "get_redis_client"]
