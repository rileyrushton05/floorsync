"""The Redis-to-hub bridge (#148): decoding a published envelope and routing it to subscribers.

The actual Redis pub/sub loop (`_listen_once`) is not exercised here -- there is no reachable
Redis in this suite (confirmed directly: the default `redis_url` resolves a docker-compose-only
hostname). What's tested is everything that does not require a live connection: decoding,
frame shaping, routing to the right hub keys, and the start/stop task lifecycle.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest

from floorsync_api.features.live_updates.connection_hub import ConnectionHub, SubscriptionKey
from floorsync_api.features.live_updates.subscriber import (
    RECONNECT_BASE_SECONDS,
    RECONNECT_MAX_SECONDS,
    RedisLiveUpdateSubscriber,
    reconnect_delay,
)
from floorsync_common.live_updates.contracts import SimulationAnchor, SimulationChangedEnvelope

SIMULATION_ID = UUID("22222222-2222-4222-8222-222222222222")
OCCURRED_AT = datetime(2026, 9, 18, 12, 0, tzinfo=UTC)


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def _envelope(simulation_id: UUID = SIMULATION_ID) -> SimulationChangedEnvelope:
    return SimulationChangedEnvelope(
        event_id=uuid4(),
        simulation_id=simulation_id,
        sequence=18,
        occurred_at=OCCURRED_AT,
        cause="paused",
        snapshot=SimulationAnchor(
            status="paused",
            simulated_time=48.5,
            speed=Decimal("2.00"),
            makespan=180,
            observed_at=OCCURRED_AT,
        ),
    )


class FakeSocket:
    def __init__(self) -> None:
        self.received: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.received.append(data)


def test_route_broadcasts_to_every_subscriber_of_the_envelopes_simulation() -> None:
    hub = ConnectionHub()
    manager_socket = FakeSocket()
    operator_socket = FakeSocket()
    hub.register(
        SubscriptionKey(simulation_id=SIMULATION_ID, audience="manager_floor"), manager_socket
    )
    hub.register(
        SubscriptionKey(
            simulation_id=SIMULATION_ID, audience="operator_machine", machine_id=uuid4()
        ),
        operator_socket,
    )
    subscriber = RedisLiveUpdateSubscriber(hub)

    run(subscriber.route(json.dumps(_envelope().to_payload())))

    assert len(manager_socket.received) == 1
    assert len(operator_socket.received) == 1
    assert manager_socket.received[0]["audience"] == "manager_floor"
    assert operator_socket.received[0]["audience"] == "operator_machine"


def test_route_reshapes_topic_into_the_sockets_type_field() -> None:
    hub = ConnectionHub()
    socket = FakeSocket()
    hub.register(SubscriptionKey(simulation_id=SIMULATION_ID, audience="manager_floor"), socket)
    subscriber = RedisLiveUpdateSubscriber(hub)

    run(subscriber.route(json.dumps(_envelope().to_payload())))

    frame = socket.received[0]
    assert frame["type"] == "simulation.changed"
    assert "topic" not in frame
    assert frame["sequence"] == 18
    assert frame["cause"] == "paused"
    assert frame["snapshot"]["speed"] == "2.00"


def test_route_ignores_a_simulation_nobody_is_subscribed_to() -> None:
    hub = ConnectionHub()
    socket = FakeSocket()
    hub.register(SubscriptionKey(simulation_id=SIMULATION_ID, audience="manager_floor"), socket)
    subscriber = RedisLiveUpdateSubscriber(hub)

    run(subscriber.route(json.dumps(_envelope(simulation_id=uuid4()).to_payload())))

    assert socket.received == []


def test_route_drops_an_unreadable_payload_without_raising() -> None:
    subscriber = RedisLiveUpdateSubscriber(ConnectionHub())

    run(subscriber.route("not json"))  # must not raise
    run(subscriber.route(json.dumps({"v": 999})))  # wrong version, must not raise


def test_route_counts_every_payload_it_has_to_drop() -> None:
    subscriber = RedisLiveUpdateSubscriber(ConnectionHub())

    run(subscriber.route("not json"))
    run(subscriber.route(json.dumps({"v": 999})))

    assert subscriber.dropped_payloads == 2


def test_route_logs_the_event_id_of_a_payload_it_drops(
    caplog: pytest.LogCaptureFixture,
) -> None:
    subscriber = RedisLiveUpdateSubscriber(ConnectionHub())
    event_id = str(uuid4())

    run(subscriber.route(json.dumps({"v": 999, "event_id": event_id})))

    [record] = [r for r in caplog.records if r.levelname == "ERROR"]
    assert record.event_id == event_id  # type: ignore[attr-defined]


def test_route_does_not_count_a_good_payload() -> None:
    subscriber = RedisLiveUpdateSubscriber(ConnectionHub())

    run(subscriber.route(json.dumps(_envelope().to_payload())))

    assert subscriber.dropped_payloads == 0


# -- reconnect backoff ------------------------------------------------------------------------


def test_reconnect_delay_grows_with_each_failure() -> None:
    # Jitter is 50-100% of the ceiling, so the ceiling of failure n is a floor for n + 1's cap.
    first = [reconnect_delay(1) for _ in range(50)]
    third = [reconnect_delay(3) for _ in range(50)]

    assert all(RECONNECT_BASE_SECONDS * 0.5 <= d <= RECONNECT_BASE_SECONDS for d in first)
    assert all(RECONNECT_BASE_SECONDS * 4 * 0.5 <= d <= RECONNECT_BASE_SECONDS * 4 for d in third)


def test_reconnect_delay_is_capped() -> None:
    delays = [reconnect_delay(50) for _ in range(50)]

    assert all(RECONNECT_MAX_SECONDS * 0.5 <= d <= RECONNECT_MAX_SECONDS for d in delays)


def test_reconnect_delay_is_jittered() -> None:
    assert len({reconnect_delay(5) for _ in range(50)}) > 1


def test_route_accepts_bytes_the_same_as_str() -> None:
    hub = ConnectionHub()
    socket = FakeSocket()
    hub.register(SubscriptionKey(simulation_id=SIMULATION_ID, audience="manager_floor"), socket)
    subscriber = RedisLiveUpdateSubscriber(hub)

    run(subscriber.route(json.dumps(_envelope().to_payload()).encode("utf-8")))

    assert len(socket.received) == 1


# -- start/stop lifecycle ---------------------------------------------------------------------


def test_stop_before_start_is_a_noop() -> None:
    subscriber = RedisLiveUpdateSubscriber(ConnectionHub())

    run(subscriber.stop())  # must not raise


def test_start_then_stop_cancels_the_background_task(monkeypatch: pytest.MonkeyPatch) -> None:
    listening = asyncio.Event()

    async def fake_listen_once(self: RedisLiveUpdateSubscriber) -> None:
        listening.set()
        await asyncio.Event().wait()  # blocks until cancelled

    monkeypatch.setattr(RedisLiveUpdateSubscriber, "_listen_once", fake_listen_once)

    async def scenario() -> None:
        subscriber = RedisLiveUpdateSubscriber(ConnectionHub())
        subscriber.start()
        await listening.wait()
        await subscriber.stop()
        assert subscriber._task is None

    run(scenario())


def test_starting_twice_does_not_replace_the_running_task(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_listen_once(self: RedisLiveUpdateSubscriber) -> None:
        await asyncio.Event().wait()

    monkeypatch.setattr(RedisLiveUpdateSubscriber, "_listen_once", fake_listen_once)

    async def scenario() -> None:
        subscriber = RedisLiveUpdateSubscriber(ConnectionHub())
        subscriber.start()
        first_task = subscriber._task
        subscriber.start()
        assert subscriber._task is first_task
        await subscriber.stop()

    run(scenario())
