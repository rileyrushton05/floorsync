"""The `/ws` connection rate limiter (#148): a fixed one-minute window per account and per IP.

There is no reachable Redis in this suite (confirmed directly elsewhere in this session: the
default `redis_url` resolves a docker-compose-only hostname), so `get_redis_client` is stubbed
with a small fake that mimics `INCR`/`EXPIRE` well enough to prove the counting and cutoff logic.
"""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import uuid4

import pytest

from floorsync_api.features.live_updates import rate_limit as rate_limit_module
from floorsync_api.features.live_updates.rate_limit import (
    MAX_CONNECTIONS_PER_WINDOW,
    check_account,
    check_ip,
)


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


class FakeRedis:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.expired: list[tuple[str, bool]] = []

    async def incr(self, key: str) -> int:
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    async def expire(self, key: str, _seconds: int, *, nx: bool = False) -> None:
        self.expired.append((key, nx))


def _stub_redis(monkeypatch: pytest.MonkeyPatch, redis: FakeRedis) -> None:
    monkeypatch.setattr(rate_limit_module, "get_redis_client", lambda: redis)


def test_allows_up_to_the_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    _stub_redis(monkeypatch, redis)

    results = [run(check_ip("1.2.3.4")) for _ in range(MAX_CONNECTIONS_PER_WINDOW)]

    assert all(results)


def test_denies_once_the_limit_is_exceeded(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    _stub_redis(monkeypatch, redis)

    for _ in range(MAX_CONNECTIONS_PER_WINDOW):
        run(check_ip("1.2.3.4"))

    assert run(check_ip("1.2.3.4")) is False


def test_every_hit_asks_for_an_expiry_that_only_applies_when_there_is_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Never "expire only on the first hit": a process that died between INCR and EXPIRE would
    leave a counter that never expires. EXPIRE NX on every hit repairs that and never extends a
    window that is already running."""

    redis = FakeRedis()
    _stub_redis(monkeypatch, redis)

    run(check_ip("1.2.3.4"))
    run(check_ip("1.2.3.4"))

    key = "floorsync:live-ws:ratelimit:ip:1.2.3.4"
    assert redis.expired == [(key, True), (key, True)]


def test_ip_and_account_counters_are_independent(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    _stub_redis(monkeypatch, redis)
    user_id = uuid4()

    for _ in range(MAX_CONNECTIONS_PER_WINDOW):
        run(check_ip("1.2.3.4"))

    assert run(check_account(user_id)) is True


def test_different_ips_are_tracked_separately(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    _stub_redis(monkeypatch, redis)

    for _ in range(MAX_CONNECTIONS_PER_WINDOW):
        run(check_ip("1.2.3.4"))

    assert run(check_ip("5.6.7.8")) is True
