"""This API process's Redis connection for live-update delivery.

Direct `redis-py` usage, deliberately not Celery's broker connection -- the live channel must stay
independent of task-queue configuration. Redis database 0; Celery stays on database 1 (see
`docs/decisions/0017-live-update-outbox.md`).
"""

from __future__ import annotations

from typing import Final

from redis.asyncio import Redis

from floorsync_common.settings import settings

SUBSCRIBER_HEALTH_CHECK_SECONDS: Final = 30

SIMULATION_CHANGED_CHANNEL = f"{settings.live_update_channel_prefix}.simulation.changed"
"""The one Redis channel this ticket publishes on today; the prefix is configurable so two
environments sharing one Redis never hear each other."""

_client: Redis | None = None
_subscriber_client: Redis | None = None


def get_redis_client() -> Redis:
    """This process's shared connection for commands: publish, tickets, rate limits, health.

    Connect and read are both bounded. Without that, a Redis that hangs instead of refusing (a
    blackholed host, a stalled failover) would hold every control's response, every ticket request
    and the relay's row locks until the operating system gave up minutes later.
    """
    global _client
    if _client is None:
        timeout = settings.redis_socket_timeout_seconds
        _client = Redis.from_url(
            settings.redis_url, socket_connect_timeout=timeout, socket_timeout=timeout
        )
    return _client


def get_subscriber_client() -> Redis:
    """The subscriber's own connection, kept apart from `get_redis_client`.

    A subscription is idle between messages, so it must not carry the read timeout the command
    client uses or every quiet minute would drop a healthy connection. The connect is still
    bounded; keepalive and health checks are what notice a connection that died while idle.
    """
    global _subscriber_client
    if _subscriber_client is None:
        _subscriber_client = Redis.from_url(
            settings.redis_url,
            socket_connect_timeout=settings.redis_socket_timeout_seconds,
            socket_timeout=None,
            socket_keepalive=True,
            health_check_interval=SUBSCRIBER_HEALTH_CHECK_SECONDS,
        )
    return _subscriber_client


async def close_redis_client() -> None:
    """Release both connections. Called from the app's lifespan shutdown."""
    global _client, _subscriber_client
    if _client is not None:
        await _client.aclose()
        _client = None
    if _subscriber_client is not None:
        await _subscriber_client.aclose()
        _subscriber_client = None


__all__ = [
    "SIMULATION_CHANGED_CHANNEL",
    "close_redis_client",
    "get_redis_client",
    "get_subscriber_client",
]
