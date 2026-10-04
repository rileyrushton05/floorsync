"""Cross-instance live-update delivery over a real Redis (#148's own DoD: prove this, not just
unit-test it).

Every other live-update test in `tests/backend` stubs Redis, because none is reachable there. This
one is the deliberate exception: it needs a real Redis to prove the property those stubs cannot --
that one publish reaches every API instance's subscriber, not just the one that made it. It
self-skips when no Redis answers at `LIVE_UPDATE_TEST_REDIS_URL` (default
`redis://localhost:6379/0`, matching `docker-compose.yml`'s `redis` service), so a normal
`uv run pytest` run is unaffected. Run it for real with Redis up, e.g. `docker compose up -d redis`
or a local `redis-server`, then `uv run pytest tests/integration -q`.
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

import pytest
from redis.asyncio import Redis

from floorsync_api.features.live_updates.connection_hub import ConnectionHub, SubscriptionKey
from floorsync_api.features.live_updates.redis_client import SIMULATION_CHANGED_CHANNEL
from floorsync_api.features.live_updates.subscriber import RedisLiveUpdateSubscriber
from floorsync_common.live_updates.contracts import SimulationAnchor, SimulationChangedEnvelope

REDIS_URL = os.environ.get("LIVE_UPDATE_TEST_REDIS_URL", "redis://localhost:6379/0")


async def _redis_is_reachable() -> bool:
    client = Redis.from_url(REDIS_URL)
    try:
        await asyncio.wait_for(client.ping(), timeout=0.5)
    except Exception:
        return False
    finally:
        await client.aclose()
    return True


pytestmark = pytest.mark.skipif(
    not asyncio.run(_redis_is_reachable()),
    reason=f"No Redis reachable at {REDIS_URL} (see this module's docstring).",
)


class FakeSocket:
    def __init__(self) -> None:
        self.received: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.received.append(data)


def _envelope(simulation_id: Any) -> SimulationChangedEnvelope:
    now = datetime.now(UTC)
    return SimulationChangedEnvelope(
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


async def _consume_one(
    client: Redis, subscriber: RedisLiveUpdateSubscriber, ready: asyncio.Event
) -> None:
    """Mimic one API instance's subscriber loop for exactly one message, on its own connection."""
    pubsub = client.pubsub()
    await pubsub.subscribe(SIMULATION_CHANGED_CHANNEL)
    try:
        ready.set()
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            await subscriber.route(message["data"])
            return
    finally:
        await pubsub.unsubscribe(SIMULATION_CHANGED_CHANNEL)
        await pubsub.aclose()  # type: ignore[no-untyped-call]


def test_one_publish_reaches_every_instances_hub() -> None:
    """Two independent Redis connections, standing in for two API processes, both subscribed to
    the live channel. A publish on a third connection (standing in for whichever instance actually
    handled the request) must reach both -- proving Redis pub/sub, not just this process's
    in-memory hub, is what makes delivery cross-instance."""

    simulation_id = uuid4()
    key = SubscriptionKey(simulation_id=simulation_id, audience="manager_floor")
    hub_a, hub_b = ConnectionHub(), ConnectionHub()
    socket_a, socket_b = FakeSocket(), FakeSocket()
    hub_a.register(key, socket_a)
    hub_b.register(key, socket_b)

    async def scenario() -> None:
        client_a, client_b, publisher = (
            Redis.from_url(REDIS_URL),
            Redis.from_url(REDIS_URL),
            Redis.from_url(REDIS_URL),
        )
        try:
            ready_a, ready_b = asyncio.Event(), asyncio.Event()
            task_a = asyncio.create_task(
                _consume_one(client_a, RedisLiveUpdateSubscriber(hub_a), ready_a)
            )
            task_b = asyncio.create_task(
                _consume_one(client_b, RedisLiveUpdateSubscriber(hub_b), ready_b)
            )
            await asyncio.wait_for(asyncio.gather(ready_a.wait(), ready_b.wait()), timeout=5)

            payload = json.dumps(_envelope(simulation_id).to_payload())
            await publisher.publish(SIMULATION_CHANGED_CHANNEL, payload)

            await asyncio.wait_for(asyncio.gather(task_a, task_b), timeout=5)
        finally:
            await client_a.aclose()
            await client_b.aclose()
            await publisher.aclose()

    asyncio.run(scenario())

    assert len(socket_a.received) == 1
    assert len(socket_b.received) == 1
    assert socket_a.received[0]["type"] == "simulation.changed"
    assert socket_a.received[0]["simulation_id"] == str(simulation_id)
    assert socket_b.received[0]["simulation_id"] == str(simulation_id)
