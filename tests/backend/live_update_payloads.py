"""A payload every subscriber accepts, for tests that need an outbox row worth publishing."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

from floorsync_common.live_updates.contracts import SimulationAnchor, SimulationChangedEnvelope


def valid_payload() -> dict[str, Any]:
    now = datetime(2026, 9, 18, 12, 0, tzinfo=UTC)
    return SimulationChangedEnvelope(
        event_id=uuid4(),
        simulation_id=uuid4(),
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
    ).to_payload()
