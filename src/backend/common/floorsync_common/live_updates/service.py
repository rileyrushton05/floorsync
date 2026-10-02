"""Record that a simulation changed, durably, alongside the change itself, and track its delivery.

Every read and write of `live_update_outbox` lives here, so the API's publisher, relay and health
signal hold Redis and sockets but no SQL.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import func, select, update
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
from floorsync_common.live_updates.results import (
    MarkPublishedResult,
    OutboxBacklog,
    OutboxRowAlreadySettled,
    OutboxRowPublished,
    SimulationChangeEnqueued,
)
from floorsync_common.simulation.events import SimulatedTimePoint


class LiveUpdateOutboxService:
    """Write outbox rows and record their delivery, in the caller's transaction. Stateless.

    Never commits, never publishes, never opens a socket: the route that recorded the change
    commits both together and only then hands the row's id to the publisher. Every method takes
    the caller's session and leaves the transaction to it.
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

    @staticmethod
    async def load_unpublished(db: AsyncSession, outbox_id: UUID) -> LiveUpdateOutbox | None:
        """The row to publish straight after commit, or `None` if it is already settled.

        No lock: the immediate publisher and the relay may both send the same row, which the
        envelope's `event_id` and `sequence` let a client discard. Blocking the request path on a
        relay's lock would cost more than a duplicate message.
        """
        result = await db.execute(
            select(LiveUpdateOutbox).where(
                LiveUpdateOutbox.id == outbox_id,
                LiveUpdateOutbox.published_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def claim_due(
        db: AsyncSession, *, now: datetime, limit: int
    ) -> Sequence[LiveUpdateOutbox]:
        """Lock up to `limit` unpublished rows whose next attempt is due, oldest due first.

        `SKIP LOCKED` is what makes several relays safe: a row another relay holds is passed over
        rather than waited for, so no two relays ever hold the same row and none blocks the
        other. The locks last until the caller's transaction ends, so the caller publishes and
        settles each row before committing.
        """
        return (
            await db.scalars(
                select(LiveUpdateOutbox)
                .where(
                    LiveUpdateOutbox.published_at.is_(None),
                    LiveUpdateOutbox.next_attempt_at <= now,
                )
                .order_by(LiveUpdateOutbox.next_attempt_at, LiveUpdateOutbox.created_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        ).all()

    @staticmethod
    async def mark_published(
        db: AsyncSession, outbox_id: UUID, *, at: datetime
    ) -> MarkPublishedResult:
        """Record that Redis accepted the row. Only the first caller to mark a row wins."""
        marked = await db.scalar(
            update(LiveUpdateOutbox)
            .where(
                LiveUpdateOutbox.id == outbox_id,
                LiveUpdateOutbox.published_at.is_(None),
            )
            .values(published_at=at)
            .returning(LiveUpdateOutbox.id)
            .execution_options(synchronize_session=False)
        )
        if marked is None:
            return OutboxRowAlreadySettled(outbox_id=outbox_id)
        return OutboxRowPublished(outbox_id=outbox_id)

    @staticmethod
    async def record_failure(
        db: AsyncSession, outbox_id: UUID, *, error_code: str, retry_at: datetime
    ) -> None:
        """Count a failed publish and hold the row back until `retry_at`.

        The retry policy (how far to back off) belongs to the relay; this only records what it
        decided. A row that was published or pruned in the meantime is left alone.
        """
        await db.execute(
            update(LiveUpdateOutbox)
            .where(
                LiveUpdateOutbox.id == outbox_id,
                LiveUpdateOutbox.published_at.is_(None),
            )
            .values(
                attempt_count=LiveUpdateOutbox.attempt_count + 1,
                next_attempt_at=retry_at,
                last_error_code=error_code,
            )
            .execution_options(synchronize_session=False)
        )

    @staticmethod
    async def backlog(db: AsyncSession) -> OutboxBacklog:
        """How many rows are still unpublished, and when the oldest was written."""
        count, oldest = (
            await db.execute(
                select(func.count(), func.min(LiveUpdateOutbox.created_at)).where(
                    LiveUpdateOutbox.published_at.is_(None)
                )
            )
        ).one()
        return OutboxBacklog(unpublished_count=count, oldest_created_at=oldest)


__all__ = ["LiveUpdateOutboxService"]
