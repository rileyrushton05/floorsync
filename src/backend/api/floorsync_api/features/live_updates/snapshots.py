"""Build the `simulation.snapshot` frame a client receives right after it subscribes.

Machine-scoped detail is deliberately not built here yet -- the ticket allows the canonical anchor
to ship first behind the same envelope, with per-machine projection added later without changing
this frame's outer shape (`snapshot` stays an object; a `machine`/`machines` key is additive).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, assert_never
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.features.live_updates.subscriptions import AudienceScope
from floorsync_common.live_updates.contracts import ENVELOPE_VERSION, SimulationAnchor
from floorsync_common.simulation.results import (
    ScheduleNotGenerated,
    SimulationNotFound,
    SimulationPositionResolved,
)
from floorsync_common.simulation.service import SimulationService

SIMULATION_SNAPSHOT = "simulation.snapshot"


@dataclass(frozen=True, slots=True)
class SnapshotUnavailable:
    """The simulation could not be resolved right now (unknown, or its schedule ungenerated)."""


type BuildSnapshotResult = dict[str, Any] | SnapshotUnavailable


class LiveUpdateSnapshotService:
    """Read a simulation's current position and shape it into the socket's snapshot frame."""

    @staticmethod
    async def build(
        db: AsyncSession, *, simulation_id: UUID, audience: AudienceScope
    ) -> BuildSnapshotResult:
        result = await SimulationService.get_simulation(db, simulation_id=simulation_id)
        match result:
            case SimulationPositionResolved():
                pass
            case SimulationNotFound() | ScheduleNotGenerated():
                return SnapshotUnavailable()
            case _:
                assert_never(result)

        observed_at = datetime.now(UTC)
        anchor = SimulationAnchor(
            status=result.simulation.status,
            simulated_time=result.position.time,
            speed=result.simulation.speed,
            makespan=result.makespan,
            observed_at=observed_at,
        )
        return {
            "v": ENVELOPE_VERSION,
            "type": SIMULATION_SNAPSHOT,
            # A snapshot is not a retried outbox row, so this id only identifies this one frame
            # to the client's own deduplication bookkeeping -- it names nothing that gets resent.
            "event_id": str(uuid4()),
            "simulation_id": str(simulation_id),
            "sequence": result.simulation.live_sequence,
            "occurred_at": observed_at.isoformat(),
            "audience": audience,
            "snapshot": _anchor_payload(anchor),
        }


def _anchor_payload(anchor: SimulationAnchor) -> dict[str, Any]:
    return {
        "status": anchor.status,
        "simulated_time": anchor.simulated_time,
        "speed": str(anchor.speed),
        "makespan": anchor.makespan,
        "observed_at": anchor.observed_at.isoformat(),
    }


__all__ = ["SIMULATION_SNAPSHOT", "LiveUpdateSnapshotService", "SnapshotUnavailable"]
