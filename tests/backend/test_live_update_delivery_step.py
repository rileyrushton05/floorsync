"""The step the publisher and the relay share: validate an outbox payload, then publish it.

Redis is stubbed (the real publish is covered against a real server in `tests/integration`).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from live_update_payloads import valid_payload
from redis.exceptions import RedisError

from floorsync_api.features.live_updates import delivery as delivery_module
from floorsync_api.features.live_updates.delivery import (
    Delivered,
    PayloadUnreadable,
    RedisRefused,
    deliver,
)
from floorsync_api.features.live_updates.redis_client import SIMULATION_CHANGED_CHANNEL


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


class FakeRedis:
    def __init__(self, *, error: RedisError | None = None) -> None:
        self.error = error
        self.published: list[tuple[str, str]] = []

    async def publish(self, channel: str, message: str) -> None:
        if self.error is not None:
            raise self.error
        self.published.append((channel, message))


def _stub(monkeypatch: pytest.MonkeyPatch, redis: FakeRedis) -> FakeRedis:
    monkeypatch.setattr(delivery_module, "get_redis_client", lambda: redis)
    return redis


def test_a_readable_payload_is_published_verbatim(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = _stub(monkeypatch, FakeRedis())
    payload = valid_payload()

    result = run(deliver(payload))

    assert result == Delivered()
    assert redis.published == [(SIMULATION_CHANGED_CHANNEL, json.dumps(payload))]


def test_an_unreadable_payload_is_not_published_and_reports_its_event_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    redis = _stub(monkeypatch, FakeRedis())

    result = run(deliver({"v": 999, "event_id": "abc"}))

    assert result == PayloadUnreadable(event_id="abc")
    assert redis.published == []


@pytest.mark.parametrize("payload", [{}, [], "text", None])
def test_an_unreadable_payload_without_an_event_id_still_reports_unreadable(
    monkeypatch: pytest.MonkeyPatch, payload: Any
) -> None:
    redis = _stub(monkeypatch, FakeRedis())

    result = run(deliver(payload))

    assert result == PayloadUnreadable(event_id=None)
    assert redis.published == []


def test_a_redis_failure_is_reported_not_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    error = RedisError("Redis is unreachable.")
    _stub(monkeypatch, FakeRedis(error=error))

    result = run(deliver(valid_payload()))

    assert result == RedisRefused(error=error)
