"""The connection hub, subscription authoriser, and snapshot builder behind the `/ws` protocol.

The socket endpoint itself has its own tests (`test_live_update_websocket.py`); this file covers
each collaborator in isolation, matching how the outbox service and route wiring were tested.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest

from floorsync_api.features.live_updates.connection_hub import ConnectionHub, SubscriptionKey
from floorsync_api.features.live_updates.snapshots import (
    LiveUpdateSnapshotService,
    SnapshotUnavailable,
)
from floorsync_api.features.live_updates.subscriptions import (
    LiveSubscriptionAuthorizer,
    SubscriptionGranted,
    SubscriptionRefused,
)
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.database.models.user import User
from floorsync_common.simulation.events import SimulatedTimePoint
from floorsync_common.simulation.results import ScheduleNotGenerated, SimulationPositionResolved
from floorsync_common.users.results import ActiveUserFound, ActiveUserNotFound

SIMULATION_ID = UUID("22222222-2222-4222-8222-222222222222")
USER_ID = UUID("11111111-1111-4111-8111-111111111111")
MACHINE_ID = UUID("33333333-3333-4333-8333-333333333333")


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


# -- connection hub -------------------------------------------------------------------------


class FakeSocket:
    def __init__(self, *, fails: bool = False) -> None:
        self.fails = fails
        self.received: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        if self.fails:
            raise RuntimeError("socket is gone")
        self.received.append(data)


def _key(**overrides: Any) -> SubscriptionKey:
    defaults: dict[str, Any] = {
        "simulation_id": SIMULATION_ID,
        "audience": "manager_floor",
        "machine_id": None,
    }
    return SubscriptionKey(**{**defaults, **overrides})


def test_broadcast_reaches_every_socket_on_the_key() -> None:
    hub = ConnectionHub()
    key = _key()
    a, b = FakeSocket(), FakeSocket()
    hub.register(key, a)
    hub.register(key, b)

    run(hub.broadcast(key, {"hello": "floor"}))

    assert a.received == [{"hello": "floor"}]
    assert b.received == [{"hello": "floor"}]


def test_broadcast_to_an_empty_key_is_a_noop() -> None:
    hub = ConnectionHub()

    run(hub.broadcast(_key(), {"hello": "nobody"}))  # must not raise


def test_unregister_stops_further_delivery() -> None:
    hub = ConnectionHub()
    key = _key()
    socket = FakeSocket()
    hub.register(key, socket)

    hub.unregister(key, socket)
    run(hub.broadcast(key, {"hello": "floor"}))

    assert socket.received == []


def test_unregister_all_removes_a_socket_from_every_key() -> None:
    hub = ConnectionHub()
    socket = FakeSocket()
    manager_key = _key(audience="manager_floor")
    operator_key = _key(audience="operator_machine", machine_id=MACHINE_ID)
    hub.register(manager_key, socket)
    hub.register(operator_key, socket)

    hub.unregister_all(socket)

    assert hub.keys_for_simulation(SIMULATION_ID) == ()


def test_subscription_count_is_the_number_of_distinct_keys() -> None:
    hub = ConnectionHub()
    hub.register(_key(audience="manager_floor"), FakeSocket())
    hub.register(_key(audience="operator_machine", machine_id=MACHINE_ID), FakeSocket())

    assert hub.subscription_count() == 2


def test_socket_count_deduplicates_one_socket_subscribed_to_several_keys() -> None:
    hub = ConnectionHub()
    socket = FakeSocket()
    hub.register(_key(audience="manager_floor"), socket)
    hub.register(_key(audience="operator_machine", machine_id=MACHINE_ID), socket)

    assert hub.subscription_count() == 2
    assert hub.socket_count() == 1


def test_a_failing_socket_is_dropped_without_stopping_delivery_to_others() -> None:
    hub = ConnectionHub()
    key = _key()
    healthy, broken = FakeSocket(), FakeSocket(fails=True)
    hub.register(key, healthy)
    hub.register(key, broken)

    run(hub.broadcast(key, {"hello": "floor"}))

    assert healthy.received == [{"hello": "floor"}]
    # The broken socket must be gone afterwards, not just skipped this once.
    run(hub.broadcast(key, {"hello": "again"}))
    assert healthy.received == [{"hello": "floor"}, {"hello": "again"}]


def test_keys_for_simulation_only_returns_that_simulations_keys() -> None:
    hub = ConnectionHub()
    other_simulation = uuid4()
    hub.register(_key(), FakeSocket())
    hub.register(_key(simulation_id=other_simulation), FakeSocket())

    keys = hub.keys_for_simulation(SIMULATION_ID)

    assert keys == (_key(),)


# -- subscription authoriser -----------------------------------------------------------------


def _user(role: str = "manager", machine_id: UUID | None = None) -> User:
    return User(id=USER_ID, name="Test User", role=role, machine_id=machine_id)


def _stub_user(monkeypatch: pytest.MonkeyPatch, outcome: object) -> None:
    from floorsync_common.users import service as users_service

    async def fake(*_: object, **__: object) -> object:
        return outcome

    monkeypatch.setattr(users_service.UserService, "get_active_user", staticmethod(fake))


def _stub_simulation(monkeypatch: pytest.MonkeyPatch, simulation: Simulation | None) -> None:
    from floorsync_api.features.live_updates import subscriptions as subscriptions_module

    async def fake(*_: object, **__: object) -> Simulation | None:
        return simulation

    monkeypatch.setattr(subscriptions_module.simulation_queries, "load_simulation", fake)


def _simulation() -> Simulation:
    return Simulation(id=SIMULATION_ID, schedule_id=uuid4(), status="running", speed=Decimal("1"))


def test_a_manager_is_granted_the_whole_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _user("manager")
    _stub_user(monkeypatch, ActiveUserFound(user=manager))
    _stub_simulation(monkeypatch, _simulation())

    result = run(
        LiveSubscriptionAuthorizer.authorize(object(), user_id=USER_ID, simulation_id=SIMULATION_ID)
    )

    # `User` has identity equality (a plain DeclarativeBase, not a dataclass model), so this
    # only holds because `manager` is the exact instance the stub returned.
    assert result == SubscriptionGranted(user=manager, audience="manager_floor", machine_id=None)


def test_an_operator_with_a_machine_is_granted_that_machine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_user(monkeypatch, ActiveUserFound(user=_user("operator", MACHINE_ID)))
    _stub_simulation(monkeypatch, _simulation())

    result = run(
        LiveSubscriptionAuthorizer.authorize(object(), user_id=USER_ID, simulation_id=SIMULATION_ID)
    )

    assert isinstance(result, SubscriptionGranted)
    assert result.audience == "operator_machine"
    assert result.machine_id == MACHINE_ID


def test_an_operator_with_no_machine_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_user(monkeypatch, ActiveUserFound(user=_user("operator", None)))
    _stub_simulation(monkeypatch, _simulation())

    result = run(
        LiveSubscriptionAuthorizer.authorize(object(), user_id=USER_ID, simulation_id=SIMULATION_ID)
    )

    assert result == SubscriptionRefused()


def test_a_deactivated_account_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_user(monkeypatch, ActiveUserNotFound(user_id=USER_ID))
    _stub_simulation(monkeypatch, _simulation())

    result = run(
        LiveSubscriptionAuthorizer.authorize(object(), user_id=USER_ID, simulation_id=SIMULATION_ID)
    )

    assert result == SubscriptionRefused()


def test_an_unknown_simulation_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_user(monkeypatch, ActiveUserFound(user=_user("manager")))
    _stub_simulation(monkeypatch, None)

    result = run(
        LiveSubscriptionAuthorizer.authorize(object(), user_id=USER_ID, simulation_id=SIMULATION_ID)
    )

    assert result == SubscriptionRefused()


# -- snapshot builder -------------------------------------------------------------------------


def _position(time: float = 42.5) -> SimulatedTimePoint:
    return SimulatedTimePoint(time=time, speed=2.0, is_running=True, is_complete=False)


def _stub_get_simulation(monkeypatch: pytest.MonkeyPatch, outcome: object) -> None:
    from floorsync_common.simulation import service as simulation_service

    async def fake(*_: object, **__: object) -> object:
        return outcome

    monkeypatch.setattr(simulation_service.SimulationService, "get_simulation", staticmethod(fake))


def test_a_snapshot_carries_the_current_anchor(monkeypatch: pytest.MonkeyPatch) -> None:
    simulation = Simulation(
        id=SIMULATION_ID,
        schedule_id=uuid4(),
        status="running",
        speed=Decimal("2.00"),
        live_sequence=17,
    )
    _stub_get_simulation(
        monkeypatch,
        SimulationPositionResolved(simulation=simulation, position=_position(), makespan=180),
    )

    frame = run(
        LiveUpdateSnapshotService.build(
            object(), simulation_id=SIMULATION_ID, audience="manager_floor"
        )
    )

    assert isinstance(frame, dict)
    assert frame["type"] == "simulation.snapshot"
    assert frame["simulation_id"] == str(SIMULATION_ID)
    assert frame["sequence"] == 17
    assert frame["audience"] == "manager_floor"
    assert frame["snapshot"]["status"] == "running"
    assert frame["snapshot"]["simulated_time"] == 42.5
    assert frame["snapshot"]["speed"] == "2.00"
    assert frame["snapshot"]["makespan"] == 180


def test_a_snapshot_is_unavailable_when_the_schedule_is_ungenerated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_get_simulation(monkeypatch, ScheduleNotGenerated(schedule_id=uuid4()))

    frame = run(
        LiveUpdateSnapshotService.build(
            object(), simulation_id=SIMULATION_ID, audience="manager_floor"
        )
    )

    assert isinstance(frame, SnapshotUnavailable)
