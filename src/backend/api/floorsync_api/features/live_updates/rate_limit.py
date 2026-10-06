"""Bound how fast one caller can open new `/ws` connections (#148).

A fixed one-minute window per key: this caps worst-case churn, it does not need to be precise to
the second, and it costs one round trip rather than a sorted set per caller. Account and IP are
counted separately so a shared address (NAT, office wifi) does not throttle every account behind
it, and one compromised account cannot open connections from everywhere at once.
"""

from __future__ import annotations

from typing import Final
from uuid import UUID

from floorsync_api.features.live_updates.redis_client import get_redis_client

WINDOW_SECONDS: Final = 60
MAX_CONNECTIONS_PER_WINDOW: Final = 30

_KEY_PREFIX: Final = "floorsync:live-ws:ratelimit:"


async def check_ip(client_ip: str) -> bool:
    """`True` if `client_ip` has not yet opened `MAX_CONNECTIONS_PER_WINDOW` this window."""
    return await _check(f"{_KEY_PREFIX}ip:{client_ip}")


async def check_account(user_id: UUID) -> bool:
    """`True` if `user_id` has not yet opened `MAX_CONNECTIONS_PER_WINDOW` this window."""
    return await _check(f"{_KEY_PREFIX}account:{user_id}")


async def _check(key: str) -> bool:
    """Increment `key`, make sure it has an expiry, and report the verdict.

    `EXPIRE ... NX` only sets a TTL on a key that has none, so asking on every hit is what makes
    this safe: if the process died between `INCR` and `EXPIRE` the next hit still arms the window,
    where "expire only when the count is 1" would leave that counter alive forever and lock the
    caller out for good. Needs Redis 7 (the `nx` option).
    """
    client = get_redis_client()
    count: int = await client.incr(key)
    await client.expire(key, WINDOW_SECONDS, nx=True)
    return count <= MAX_CONNECTIONS_PER_WINDOW


__all__ = ["MAX_CONNECTIONS_PER_WINDOW", "WINDOW_SECONDS", "check_account", "check_ip"]
