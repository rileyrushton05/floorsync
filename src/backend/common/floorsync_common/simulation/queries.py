"""Named reads that feed the simulation.

These are the intention-revealing queries decision 0005 prefers over a generic
repository: each one loads exactly what a single application operation needs, and
returns the plain records the resolver consumes rather than SQLAlchemy rows.

Every function takes a caller-owned session and never commits.
"""

from collections.abc import Sequence
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.job import Job
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.schedule import Schedule
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.database.models.simulation_event import SimulationEvent
from floorsync_common.simulation.events import SimulationEventRecord, events_from_rows
from floorsync_common.simulation.floorsync import FloorSyncScheduleAdapter, ScheduleEntryRecord


async def load_schedule(db: AsyncSession, schedule_id: UUID) -> Schedule | None:
    """Load one schedule by identifier."""
    result = await db.execute(select(Schedule).where(Schedule.id == schedule_id))
    return result.scalar_one_or_none()


async def load_schedule_entries(db: AsyncSession, schedule_id: UUID) -> list[ScheduleEntryRecord]:
    """Load a schedule's entries with the names needed to display them.

    The join reaches Job through Operation because `schedule_entries` stores the
    operation, not the job. Ordering by entry id keeps the read deterministic;
    the timeline is placed on the clock using each entry's own `start_time`.
    """
    statement = (
        select(
            ScheduleEntry.id,
            Operation.job_id,
            ScheduleEntry.machine_id,
            ScheduleEntry.duration,
            Job.name,
            Machine.name,
            Operation.name,
            ScheduleEntry.start_time,
        )
        .join(Operation, Operation.id == ScheduleEntry.operation_id)
        .join(Job, Job.id == Operation.job_id)
        .join(Machine, Machine.id == ScheduleEntry.machine_id)
        .where(ScheduleEntry.schedule_id == schedule_id)
        .order_by(ScheduleEntry.id)
    )
    rows: Sequence[tuple[UUID, UUID, UUID, int, str, str, str, datetime | None]] = (
        (await db.execute(statement)).tuples().all()
    )
    return FloorSyncScheduleAdapter.entries_from_rows(rows)


async def load_simulation(db: AsyncSession, simulation_id: UUID) -> Simulation | None:
    """Load one simulation by identifier, for reading."""
    result = await db.execute(select(Simulation).where(Simulation.id == simulation_id))
    return result.scalar_one_or_none()


async def lock_simulation(db: AsyncSession, simulation_id: UUID) -> Simulation | None:
    """Load one simulation by identifier and hold its row until the transaction ends.

    The control path's read. Two managers pressing buttons at once queue here, and the second
    sees the row as the first left it, so `control_is_applicable` judges the real current status
    and the live sequence the change is announced with follows the event order (decision 0017).
    """
    result = await db.execute(
        select(Simulation).where(Simulation.id == simulation_id).with_for_update()
    )
    return result.scalar_one_or_none()


async def load_simulation_for_schedule(db: AsyncSession, schedule_id: UUID) -> Simulation | None:
    """Load the simulation belonging to a schedule, if one has been created."""
    result = await db.execute(select(Simulation).where(Simulation.schedule_id == schedule_id))
    return result.scalar_one_or_none()


async def load_active_simulation(db: AsyncSession) -> Simulation | None:
    """Load the simulation an operator should be watching right now, if any.

    A running or paused simulation wins, then one that is ready to start, then the most
    recently finished; within each, the newest. The ordering lives here so every caller
    agrees on "the" live simulation.
    """
    rank = case(
        (Simulation.status.in_(("running", "paused")), 0),
        (Simulation.status == "not_started", 1),
        else_=2,
    )
    result = await db.execute(
        select(Simulation).order_by(rank, Simulation.created_at.desc()).limit(1)
    )
    return result.scalar_one_or_none()


async def load_simulation_events(
    db: AsyncSession, simulation_id: UUID
) -> list[SimulationEventRecord]:
    """Load a simulation's control log in occurrence order.

    The replay sorts defensively, but ordering here keeps the read deterministic
    when two events share a timestamp.
    """
    statement = (
        select(
            SimulationEvent.event_type,
            SimulationEvent.occurred_at,
            SimulationEvent.speed,
            SimulationEvent.position,
        )
        .where(SimulationEvent.simulation_id == simulation_id)
        .order_by(SimulationEvent.occurred_at, SimulationEvent.id)
    )
    rows: Sequence[tuple[str, datetime, Decimal | None, float | None]] = (
        (await db.execute(statement)).tuples().all()
    )
    return events_from_rows(rows)
