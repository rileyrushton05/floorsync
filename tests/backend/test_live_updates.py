"""Live update outbox (#148): the wire contract and the service that writes it."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, cast
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.live_updates.contracts import (
    ENVELOPE_VERSION,
    SIMULATION_CHANGED,
    SimulationAnchor,
    SimulationChangedEnvelope,
    UnsupportedEnvelope,
)
from floorsync_common.live_updates.service import LiveUpdateOutboxService
from floorsync_common.simulation.events import SimulatedTimePoint

OCCURRED_AT = datetime(2026, 9, 16, 12, 0, 4, tzinfo=UTC)


def _envelope(sequence: int = 18) -> SimulationChangedEnvelope:
    return SimulationChangedEnvelope(
        event_id=uuid4(),
        simulation_id=uuid4(),
        sequence=sequence,
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


# -- contract -------------------------------------------------------------------------------


def test_an_envelope_survives_the_trip_through_its_payload() -> None:
    envelope = _envelope()

    payload = envelope.to_payload()

    assert payload["v"] == ENVELOPE_VERSION
    assert payload["topic"] == SIMULATION_CHANGED
    assert payload["snapshot"]["speed"] == "2.00"
    assert SimulationChangedEnvelope.from_payload(payload) == envelope


def test_the_payload_is_plain_json_values() -> None:
    """What crosses Redis is what a JSON encoder can write without help."""

    payload = _envelope().to_payload()

    assert isinstance(payload["event_id"], str)
    assert isinstance(payload["occurred_at"], str)
    assert payload["occurred_at"].endswith("+00:00")
    assert isinstance(payload["snapshot"]["speed"], str)


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ({"v": 2}, "version"),
        ({"topic": "simulation.deleted"}, "topic"),
        ({"cause": "exploded"}, "cause"),
        ({"sequence": "18"}, "integer"),
        ({"occurred_at": "2026-09-16T12:00:04"}, "timezone"),
        ({"snapshot": None}, "object"),
    ],
)
def test_a_payload_this_contract_cannot_vouch_for_is_refused(
    change: dict[str, Any], reason: str
) -> None:
    payload = {**_envelope().to_payload(), **change}

    with pytest.raises(UnsupportedEnvelope, match=reason):
        SimulationChangedEnvelope.from_payload(payload)


def test_a_payload_missing_a_field_is_refused_not_crashed_on() -> None:
    payload = _envelope().to_payload()
    del payload["snapshot"]["makespan"]

    with pytest.raises(UnsupportedEnvelope, match="Malformed"):
        SimulationChangedEnvelope.from_payload(payload)


def test_a_non_object_payload_is_refused() -> None:
    with pytest.raises(UnsupportedEnvelope):
        SimulationChangedEnvelope.from_payload("[]")


# -- service --------------------------------------------------------------------------------


class FakeSession:
    """Answer the sequence allocation with a counter and collect what is added."""

    def __init__(self, live_sequence: int = 0) -> None:
        self.live_sequence = live_sequence
        self.added: list[Any] = []
        self.flushes = 0

    async def scalar(self, statement: Any) -> int:
        assert "UPDATE simulations SET live_sequence" in str(statement)
        assert "RETURNING simulations.live_sequence" in str(statement)
        self.live_sequence += 1
        return self.live_sequence

    def add(self, instance: Any) -> None:
        self.added.append(instance)

    async def flush(self) -> None:
        self.flushes += 1


def _simulation(live_sequence: int = 0) -> Simulation:
    return Simulation(
        id=uuid4(),
        schedule_id=uuid4(),
        status="paused",
        speed=Decimal("2.00"),
        live_sequence=live_sequence,
    )


def _enqueue(fake: FakeSession, simulation: Simulation, cause: Any = "paused") -> Any:
    return asyncio.run(
        LiveUpdateOutboxService.enqueue_simulation_change(
            cast(AsyncSession, fake),
            simulation=simulation,
            position=SimulatedTimePoint(time=48.5, speed=2.0, is_running=False, is_complete=False),
            makespan=180,
            cause=cause,
            occurred_at=OCCURRED_AT,
        )
    )


def test_enqueue_writes_one_row_whose_payload_is_the_envelope() -> None:
    fake = FakeSession(live_sequence=17)
    simulation = _simulation(live_sequence=17)

    enqueued = _enqueue(fake, simulation)

    (row,) = fake.added
    assert isinstance(row, LiveUpdateOutbox)
    assert row.id == enqueued.outbox_id == enqueued.envelope.event_id
    assert row.topic == SIMULATION_CHANGED
    assert row.aggregate_id == simulation.id
    assert row.sequence == 18
    assert row.next_attempt_at == OCCURRED_AT
    assert row.payload == enqueued.envelope.to_payload()
    assert SimulationChangedEnvelope.from_payload(row.payload) == enqueued.envelope
    assert fake.flushes == 1


def test_the_anchor_is_the_simulation_as_the_change_left_it() -> None:
    simulation = _simulation()

    enqueued = _enqueue(FakeSession(), simulation)

    assert enqueued.envelope.snapshot == SimulationAnchor(
        status="paused",
        simulated_time=48.5,
        speed=Decimal("2.00"),
        makespan=180,
        observed_at=OCCURRED_AT,
    )
    assert enqueued.envelope.occurred_at == OCCURRED_AT
    assert enqueued.envelope.cause == "paused"


def test_sequences_climb_by_one_per_change_and_the_loaded_row_agrees() -> None:
    fake = FakeSession()
    simulation = _simulation()

    first = _enqueue(fake, simulation, cause="created")
    second = _enqueue(fake, simulation, cause="started")
    third = _enqueue(fake, simulation)

    assert [e.envelope.sequence for e in (first, second, third)] == [1, 2, 3]
    assert simulation.live_sequence == 3
    assert len({e.outbox_id for e in (first, second, third)}) == 3


def test_a_vanished_simulation_is_an_invariant_break_not_an_outcome() -> None:
    class Vanished(FakeSession):
        async def scalar(self, statement: Any) -> Any:
            return None

    with pytest.raises(RuntimeError, match="vanished"):
        _enqueue(Vanished(), _simulation())


def test_the_model_registers_with_the_shared_metadata() -> None:
    """Alembic only sees what `models/__init__` imports."""

    from floorsync_common.database import models

    assert models.LiveUpdateOutbox is LiveUpdateOutbox
    assert "live_update_outbox" in LiveUpdateOutbox.metadata.tables
