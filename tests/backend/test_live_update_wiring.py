"""The transport half of #148: route wiring and immediate Redis delivery.

The outbox contract and `LiveUpdateOutboxService` have their own tests (`test_live_updates.py`).
This file covers the seam decision 0017 leaves for the transport half: the simulation routes must
enqueue inside the same transaction as the change and publish only after it commits, creating a
simulation is announced with cause "created", each control maps to its own wire cause, a rejected
control announces nothing, and `OutboxPublisher` marks a row published only once Redis has actually
accepted it.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from redis.exceptions import RedisError

from floorsync_api.dependencies.authentication import get_current_user, require_roles
from floorsync_api.dependencies.database import get_db_session
from floorsync_api.features.live_updates import publisher as publisher_module
from floorsync_api.features.live_updates.publisher import OutboxPublisher
from floorsync_api.features.live_updates.redis_client import SIMULATION_CHANGED_CHANNEL
from floorsync_api.features.simulation.router import router as simulation_router
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.live_updates.contracts import LiveUpdateCause
from floorsync_common.live_updates.service import LiveUpdateOutboxService
from floorsync_common.simulation.events import SimulatedTimePoint, SimulationEventType
from floorsync_common.simulation.results import (
    ControlNotApplicable,
    ControlRecorded,
    SimulationCreated,
    SimulationPositionResolved,
)
from floorsync_common.simulation.service import SimulationService

SCHEDULE_ID = UUID("11111111-1111-4111-8111-111111111111")
SIMULATION_ID = UUID("22222222-2222-4222-8222-222222222222")


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


# -- route wiring ---------------------------------------------------------------------------


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_: object) -> None:
        return None


class FakeSession:
    """The service layer is stubbed per test, so the session only has to open a transaction."""

    def begin(self) -> FakeTransaction:
        return FakeTransaction()


def _simulation(status: str = "not_started") -> Simulation:
    return Simulation(id=SIMULATION_ID, schedule_id=SCHEDULE_ID, status=status, speed=Decimal("1"))


def _position(time: float = 0.0) -> SimulatedTimePoint:
    return SimulatedTimePoint(time=time, speed=1.0, is_running=True, is_complete=False)


def wiring_client() -> TestClient:
    app = FastAPI()
    app.include_router(simulation_router, prefix="/api/v1")

    class FakeUser:
        def __init__(self) -> None:
            self.id = uuid4()
            self.role = "manager"
            self.machine_id = None

    user = FakeUser()
    app.dependency_overrides[get_db_session] = lambda: FakeSession()
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[require_roles("manager")] = lambda: user
    return TestClient(app)


def _stub_outcome(monkeypatch: pytest.MonkeyPatch, method: str, outcome: object) -> None:
    async def fake(*_: object, **__: object) -> object:
        return outcome

    monkeypatch.setattr(SimulationService, method, staticmethod(fake))


def _capture_enqueue(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Stub the outbox enqueue and record every call's keyword arguments."""

    calls: list[dict[str, Any]] = []

    async def fake(_db: Any, **kwargs: Any) -> Any:
        calls.append(kwargs)
        return SimpleNamespace(outbox_id=uuid4(), envelope=None)

    monkeypatch.setattr(LiveUpdateOutboxService, "enqueue_simulation_change", staticmethod(fake))
    return calls


def _capture_publish(monkeypatch: pytest.MonkeyPatch) -> list[UUID]:
    """Stub the immediate publisher and record every outbox id it was asked to publish."""

    calls: list[UUID] = []

    async def fake(_db: Any, outbox_id: UUID) -> None:
        calls.append(outbox_id)

    monkeypatch.setattr(OutboxPublisher, "publish_now", staticmethod(fake))
    return calls


def test_create_simulation_announces_created(monkeypatch: pytest.MonkeyPatch) -> None:
    """Creating a simulation appends no event, so it is its own cause (decision 0017)."""

    _stub_outcome(monkeypatch, "create_simulation", SimulationCreated(simulation=_simulation()))
    _stub_outcome(
        monkeypatch,
        "get_simulation",
        SimulationPositionResolved(simulation=_simulation(), position=_position(), makespan=180),
    )
    enqueued = _capture_enqueue(monkeypatch)
    published = _capture_publish(monkeypatch)

    response = wiring_client().post("/api/v1/simulations", json={"schedule_id": str(SCHEDULE_ID)})

    assert response.status_code == 201
    assert len(enqueued) == 1
    assert enqueued[0]["cause"] == "created"
    assert enqueued[0]["makespan"] == 180
    assert len(published) == 1


@pytest.mark.parametrize(
    "event_type",
    ["started", "paused", "resumed", "speed_changed", "reset", "completed"],
)
def test_each_control_announces_its_own_cause(
    monkeypatch: pytest.MonkeyPatch, event_type: LiveUpdateCause
) -> None:
    """`_live_update_cause` is a maintained mapping, not a reuse of the database's own values."""

    _stub_outcome(
        monkeypatch,
        "record_control",
        ControlRecorded(
            simulation=_simulation("running"),
            event_type=SimulationEventType(event_type),
            position=_position(),
            makespan=180,
        ),
    )
    enqueued = _capture_enqueue(monkeypatch)
    published = _capture_publish(monkeypatch)

    response = wiring_client().post(
        f"/api/v1/simulations/{SIMULATION_ID}/events",
        json={"event_type": event_type, "speed": "1.5"},
    )

    assert response.status_code == 201
    assert enqueued[0]["cause"] == event_type
    assert len(published) == 1


def test_a_rejected_control_announces_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_outcome(
        monkeypatch,
        "record_control",
        ControlNotApplicable(simulation_id=SIMULATION_ID, event_type="paused", status="paused"),
    )
    enqueued = _capture_enqueue(monkeypatch)
    published = _capture_publish(monkeypatch)

    response = wiring_client().post(
        f"/api/v1/simulations/{SIMULATION_ID}/events", json={"event_type": "paused"}
    )

    assert response.status_code == 409
    assert enqueued == []
    assert published == []


# -- immediate publisher ---------------------------------------------------------------------


class FakeOutboxRow:
    def __init__(
        self, outbox_id: UUID, payload: dict[str, Any], published_at: datetime | None = None
    ) -> None:
        self.id = outbox_id
        self.payload = payload
        self.published_at = published_at


class FakePublisherTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_: object) -> None:
        return None


class FakePublisherSession:
    def __init__(self, row: FakeOutboxRow | None) -> None:
        self.row = row
        self.executed: list[Any] = []

    async def get(self, _model: Any, _id: UUID) -> FakeOutboxRow | None:
        return self.row

    def begin(self) -> FakePublisherTransaction:
        return FakePublisherTransaction()

    async def execute(self, statement: Any) -> None:
        self.executed.append(statement)
        assert self.row is not None
        self.row.published_at = datetime.now(UTC)


class FakeRedis:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.published: list[tuple[str, str]] = []

    async def publish(self, channel: str, message: str) -> None:
        if self.fail:
            raise RedisError("Redis is unreachable.")
        self.published.append((channel, message))


def test_publish_now_publishes_then_marks_the_row_published(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = FakeOutboxRow(uuid4(), {"v": 1, "topic": "simulation.changed"})
    session = FakePublisherSession(row)
    redis = FakeRedis()
    monkeypatch.setattr(publisher_module, "get_redis_client", lambda: redis)

    run(OutboxPublisher.publish_now(session, row.id))

    assert redis.published == [(SIMULATION_CHANGED_CHANNEL, json.dumps(row.payload))]
    assert row.published_at is not None
    assert len(session.executed) == 1


def test_publish_now_leaves_the_row_unpublished_when_redis_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A control's REST response must still succeed even though Redis is down."""

    row = FakeOutboxRow(uuid4(), {"v": 1})
    session = FakePublisherSession(row)
    monkeypatch.setattr(publisher_module, "get_redis_client", lambda: FakeRedis(fail=True))

    run(OutboxPublisher.publish_now(session, row.id))

    assert row.published_at is None
    assert session.executed == []


def test_publish_now_is_a_noop_for_an_already_published_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = FakeOutboxRow(uuid4(), {"v": 1}, published_at=datetime.now(UTC))
    session = FakePublisherSession(row)
    redis = FakeRedis()
    monkeypatch.setattr(publisher_module, "get_redis_client", lambda: redis)

    run(OutboxPublisher.publish_now(session, row.id))

    assert redis.published == []


def test_publish_now_is_a_noop_for_a_vanished_row(monkeypatch: pytest.MonkeyPatch) -> None:
    session = FakePublisherSession(None)
    redis = FakeRedis()
    monkeypatch.setattr(publisher_module, "get_redis_client", lambda: redis)

    run(OutboxPublisher.publish_now(session, uuid4()))

    assert redis.published == []
