"""Bound how fast one caller can open new `/ws` connections (#148).

A fixed one-minute window per key is enough here -- this exists to cap worst-case connection
churn from one account or address, not to be precise to the second, and it costs one Redis round
trip per check instead of a sorted-set per caller. Both keys share the same window and limit;
tracking account and IP separately means a shared address (NAT, office wifi) does not throttle
every account behind it, and a single compromised account does not get to open connections from
everywhere at once.
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
    """Increment `key`, arming its expiry only on the window's first hit, and report the verdict."""
    client = get_redis_client()
    count: int = await client.incr(key)
    if count == 1:
        await client.expire(key, WINDOW_SECONDS)
    return count <= MAX_CONNECTIONS_PER_WINDOW


__all__ = ["MAX_CONNECTIONS_PER_WINDOW", "WINDOW_SECONDS", "check_account", "check_ip"]
