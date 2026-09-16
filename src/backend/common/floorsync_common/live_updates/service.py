"""Record that a simulation changed, durably, alongside the change itself."""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.live_updates.contracts import (
    SIMULATION_CHANGED,
    LiveUpdateCause,
    SimulationAnchor,
    SimulationChangedEnvelope,
)
from floorsync_common.live_updates.results import SimulationChangeEnqueued
from floorsync_common.simulation.events import SimulatedTimePoint


class LiveUpdateOutboxService:
    """Write the outbox row for a change, in the caller's transaction. Stateless.

    Never commits, never publishes, never opens a socket: the route that recorded the change
    commits both together and only then hands the row's id to the publisher.
    """

    @staticmethod
    async def enqueue_simulation_change(
        db: AsyncSession,
        *,
        simulation: Simulation,
        position: SimulatedTimePoint,
        makespan: int,
        cause: LiveUpdateCause,
        occurred_at: datetime,
    ) -> SimulationChangeEnqueued:
        """Allocate the next sequence for `simulation` and record one `simulation.changed` row.

        Call after the change is flushed and with `occurred_at` equal to the change's own
        timestamp, so the anchor in the envelope is exactly the position the REST response
        reports. The sequence is taken with a single `UPDATE ... RETURNING`, so it is unique even
        for two callers that were not serialised by a row lock; the row lock on the control path
        is what keeps sequence order equal to event order.
        """
        sequence = await db.scalar(
            update(Simulation)
            .where(Simulation.id == simulation.id)
            .values(live_sequence=Simulation.live_sequence + 1)
            .returning(Simulation.live_sequence)
            .execution_options(synchronize_session=False)
        )
        if sequence is None:
            raise RuntimeError(f"Simulation {simulation.id} vanished while allocating a sequence.")
        # The database already holds the new value; tell the loaded object without marking it
        # dirty, so the flush below does not write it a second time.
        set_committed_value(simulation, "live_sequence", sequence)

        outbox_id = uuid4()
        envelope = SimulationChangedEnvelope(
            event_id=outbox_id,
            simulation_id=simulation.id,
            sequence=sequence,
            occurred_at=occurred_at,
            cause=cause,
            snapshot=SimulationAnchor(
                status=simulation.status,
                simulated_time=position.time,
                speed=simulation.speed,
                makespan=makespan,
                observed_at=occurred_at,
            ),
        )
        db.add(
            LiveUpdateOutbox(
                id=outbox_id,
                topic=SIMULATION_CHANGED,
                aggregate_id=simulation.id,
                sequence=sequence,
                payload=envelope.to_payload(),
                next_attempt_at=occurred_at,
            )
        )
        await db.flush()
        return SimulationChangeEnqueued(outbox_id=outbox_id, envelope=envelope)


__all__ = ["LiveUpdateOutboxService"]
