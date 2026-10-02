"""A Redis restart must not end live delivery for the life of an API process (#148's DoD).

`test_live_update_cross_instance.py` proves one publish reaches several instances; it feeds the
subscriber's `route()` directly. This runs the subscriber's real listen loop against a Redis server
this test starts itself, stops it, starts it again, and checks delivery resumes on its own -- the
reconnect backoff exercised for real instead of faked. It needs a `redis-server` binary and skips
when there is none.
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

from floorsync_api.features.live_updates import subscriber as subscriber_module
from floorsync_api.features.live_updates.connection_hub import ConnectionHub, SubscriptionKey
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
    monkeypatch.setattr(subscriber_module, "get_redis_client", lambda: shared)

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
