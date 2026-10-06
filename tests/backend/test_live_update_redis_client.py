"""The Redis connections' timeouts (#148 review): a hanging Redis must not hang the API.

A Redis that refuses a connection fails at once; one that accepts and never answers (a blackholed
host, a stalled failover) is the dangerous case, because without a timeout every control's
response, every ticket request and the relay's row locks wait on it. These tests use a server that
accepts connections and says nothing, and assert each path gives up quickly instead.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from redis.exceptions import RedisError

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.features.live_updates import redis_client as redis_client_module
from floorsync_api.features.live_updates.redis_client import (
    SIMULATION_CHANGED_CHANNEL,
    get_redis_client,
    get_subscriber_client,
)
from floorsync_api.features.live_updates.router import router as live_updates_router

TIMEOUT = 0.3
BOUND = 3.0  # far above TIMEOUT, far below the minutes an unbounded socket would wait


@asynccontextmanager
async def blackhole() -> AsyncIterator[int]:
    """A server that accepts connections and never replies."""

    async def hold(_reader: asyncio.StreamReader, _writer: asyncio.StreamWriter) -> None:
        await asyncio.sleep(3600)

    server = await asyncio.start_server(hold, "127.0.0.1", 0)
    try:
        yield int(server.sockets[0].getsockname()[1])
    finally:
        server.close()


@pytest.fixture
def point_at(monkeypatch: pytest.MonkeyPatch) -> Any:
    def configure(port: int) -> None:
        settings = redis_client_module.settings
        monkeypatch.setattr(settings, "redis_url", f"redis://127.0.0.1:{port}/0")
        monkeypatch.setattr(settings, "redis_socket_timeout_seconds", TIMEOUT)
        monkeypatch.setattr(redis_client_module, "_client", None)
        monkeypatch.setattr(redis_client_module, "_subscriber_client", None)

    return configure


def test_a_publish_to_a_hanging_redis_gives_up_within_the_timeout(point_at: Any) -> None:
    async def scenario() -> float:
        async with blackhole() as port:
            point_at(port)
            started = time.monotonic()
            with pytest.raises(RedisError):
                await get_redis_client().publish(SIMULATION_CHANGED_CHANNEL, "{}")
            elapsed = time.monotonic() - started
            await redis_client_module.close_redis_client()
            return elapsed

    assert asyncio.run(scenario()) < BOUND


def test_a_ticket_request_to_a_hanging_redis_is_a_503_not_a_hang(point_at: Any) -> None:
    app = FastAPI()
    app.include_router(live_updates_router, prefix="/api/v1")

    class FakeUser:
        id = UUID("11111111-1111-4111-8111-111111111111")
        role = "operator"
        machine_id = None

    app.dependency_overrides[get_current_user] = lambda: FakeUser()

    async def scenario() -> tuple[int, float]:
        async with blackhole() as port:
            point_at(port)
            # TestClient drives the app on its own thread and loop, so go through a real request
            # from a worker thread while this loop keeps the blackhole serving.
            started = time.monotonic()
            response = await asyncio.to_thread(TestClient(app).post, "/api/v1/live-updates/tickets")
            return response.status_code, time.monotonic() - started

    status, elapsed = asyncio.run(scenario())

    assert status == 503
    assert elapsed < BOUND


def test_the_command_client_has_a_read_timeout_and_the_subscriber_client_does_not(
    point_at: Any,
) -> None:
    point_at(6379)

    commands = get_redis_client().connection_pool.connection_kwargs
    subscriber = get_subscriber_client().connection_pool.connection_kwargs

    assert commands["socket_timeout"] == TIMEOUT
    assert commands["socket_connect_timeout"] == TIMEOUT
    # An idle subscription must not be cut by a read timeout, but connecting is still bounded and
    # keepalive / health checks are what notice a connection that died while idle.
    assert subscriber["socket_timeout"] is None
    assert subscriber["socket_connect_timeout"] == TIMEOUT
    assert subscriber["socket_keepalive"] is True
    assert subscriber["health_check_interval"] > 0
    assert get_redis_client() is not get_subscriber_client()
