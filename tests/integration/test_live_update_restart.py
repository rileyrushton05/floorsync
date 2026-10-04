"""How the live-update Redis connections behave against a real `redis-server` (#148).

`test_live_update_cross_instance.py` proves one publish reaches several instances; it feeds the
subscriber's `route()` directly. This runs the subscriber's real listen loop against a Redis server
this test starts itself, stops it, starts it again, and checks delivery resumes on its own -- the
reconnect backoff exercised for real instead of faked. It needs a `redis-server` binary and skips
when there is none.

Also here, because they need the same throwaway server: an idle subscriber must not be cut by the
command client's read timeout, and the rate limiter's `EXPIRE NX` must repair a counter that was
left without an expiry.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import shutil
import socket
import subprocess
import time
from collections.abc import Iterator
from contextlib import closing
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from redis.asyncio import Redis

from floorsync_api.features.live_updates import rate_limit as rate_limit_module
from floorsync_api.features.live_updates import redis_client as redis_client_module
from floorsync_api.features.live_updates import subscriber as subscriber_module
from floorsync_api.features.live_updates.connection_hub import ConnectionHub, SubscriptionKey
from floorsync_api.features.live_updates.rate_limit import WINDOW_SECONDS, check_ip
from floorsync_api.features.live_updates.redis_client import SIMULATION_CHANGED_CHANNEL
from floorsync_api.features.live_updates.subscriber import RedisLiveUpdateSubscriber
from floorsync_common.live_updates.contracts import SimulationAnchor, SimulationChangedEnvelope

pytestmark = pytest.mark.skipif(
    shutil.which("redis-server") is None, reason="No redis-server binary on PATH."
)


class RedisServer:
    """One throwaway `redis-server` on a private port that can be stopped and started again."""

    def __init__(self) -> None:
        with closing(socket.socket()) as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = int(sock.getsockname()[1])
        self._process: subprocess.Popen[bytes] | None = None

    @property
    def url(self) -> str:
        return f"redis://127.0.0.1:{self.port}/0"

    def start(self) -> None:
        self._process = subprocess.Popen(
            [
                "redis-server",
                "--port",
                str(self.port),
                "--bind",
                "127.0.0.1",
                "--save",
                "",
                "--appendonly",
                "no",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with closing(socket.socket()) as sock:
                if sock.connect_ex(("127.0.0.1", self.port)) == 0:
                    return
            time.sleep(0.05)
        self.stop()
        raise RuntimeError("redis-server did not start")

    def stop(self) -> None:
        if self._process is not None:
            self._process.kill()  # an abrupt loss, like a crash, not a graceful shutdown
            self._process.wait(timeout=5)
            self._process = None


@pytest.fixture
def redis_server() -> Iterator[RedisServer]:
    server = RedisServer()
    server.start()
    yield server
    server.stop()


class FakeSocket:
    def __init__(self) -> None:
        self.received: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.received.append(data)


def _payload(simulation_id: UUID) -> str:
    now = datetime.now(UTC)
    envelope = SimulationChangedEnvelope(
        event_id=uuid4(),
        simulation_id=simulation_id,
        sequence=1,
        occurred_at=now,
        cause="paused",
        snapshot=SimulationAnchor(
            status="paused",
            simulated_time=1.0,
            speed=Decimal("1.00"),
            makespan=10,
            observed_at=now,
        ),
    )
    return json.dumps(envelope.to_payload())


def test_delivery_resumes_after_redis_restarts(
    redis_server: RedisServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    simulation_id = uuid4()
    hub = ConnectionHub()
    socket_ = FakeSocket()
    hub.register(SubscriptionKey(simulation_id=simulation_id, audience="manager_floor"), socket_)
    shared = Redis.from_url(redis_server.url)
    monkeypatch.setattr(subscriber_module, "get_subscriber_client", lambda: shared)

    async def publish_until_delivered(count: int, *, timeout: float) -> bool:
        """Publish repeatedly (the subscriber may not be listening yet, or Redis may be mid-
        restart) until the socket has received `count` messages or `timeout` runs out."""
        publisher = Redis.from_url(redis_server.url)
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                with contextlib.suppress(Exception):
                    await publisher.publish(SIMULATION_CHANGED_CHANNEL, _payload(simulation_id))
                await asyncio.sleep(0.2)
                if len(socket_.received) >= count:
                    return True
            return False
        finally:
            await publisher.aclose()

    async def scenario() -> None:
        subscriber = RedisLiveUpdateSubscriber(hub)
        subscriber.start()
        try:
            assert await publish_until_delivered(1, timeout=5), "no delivery before the restart"

            redis_server.stop()
            redis_server.start()

            received = len(socket_.received)
            assert await publish_until_delivered(received + 1, timeout=20), (
                "the subscriber never reconnected after Redis restarted"
            )
            assert subscriber.running
        finally:
            await subscriber.stop()
            await shared.aclose()

    asyncio.run(scenario())


def test_an_idle_subscriber_is_not_dropped_by_the_command_timeout(
    redis_server: RedisServer, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The command client reads with a timeout; a subscription is idle between messages, so it
    uses its own client without one. With the timeout shrunk to 0.3 s, sitting idle for four
    times that must not drop the connection."""

    settings = redis_client_module.settings
    monkeypatch.setattr(settings, "redis_url", redis_server.url)
    monkeypatch.setattr(settings, "redis_socket_timeout_seconds", 0.3)
    monkeypatch.setattr(redis_client_module, "_client", None)
    monkeypatch.setattr(redis_client_module, "_subscriber_client", None)
    simulation_id = uuid4()
    hub = ConnectionHub()
    socket_ = FakeSocket()
    hub.register(SubscriptionKey(simulation_id=simulation_id, audience="manager_floor"), socket_)

    async def scenario() -> None:
        subscriber = RedisLiveUpdateSubscriber(hub)
        subscriber.start()
        try:
            await asyncio.sleep(1.2)  # idle, well past the command timeout
            publisher = Redis.from_url(redis_server.url)
            try:
                await publisher.publish(SIMULATION_CHANGED_CHANNEL, _payload(simulation_id))
            finally:
                await publisher.aclose()
            deadline = time.monotonic() + 3
            while not socket_.received and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
        finally:
            await subscriber.stop()
            await redis_client_module.close_redis_client()

    asyncio.run(scenario())

    assert len(socket_.received) == 1
    assert not [r for r in caplog.records if "lost its Redis connection" in r.getMessage()]


def test_the_rate_limiter_repairs_a_counter_that_was_left_without_an_expiry(
    redis_server: RedisServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A process that died between INCR and EXPIRE leaves a counter with no TTL. EXPIRE NX on the
    next hit gives it one, and a later hit does not push an already-running window out."""

    async def scenario() -> tuple[int, int, int]:
        client = Redis.from_url(redis_server.url)
        monkeypatch.setattr(rate_limit_module, "get_redis_client", lambda: client)
        key = "floorsync:live-ws:ratelimit:ip:9.9.9.9"
        try:
            await client.incr(key)  # the crash: counted, never given an expiry
            before = await client.ttl(key)
            await check_ip("9.9.9.9")
            armed = await client.ttl(key)
            await asyncio.sleep(1.1)
            await check_ip("9.9.9.9")
            later = await client.ttl(key)
            return before, armed, later
        finally:
            await client.aclose()

    before, armed, later = asyncio.run(scenario())

    assert before == -1  # no expiry, as a crashed process would have left it
    assert 0 < armed <= WINDOW_SECONDS
    assert later < armed  # the window kept running; it was not reset to a full minute
