"""Transitions a stored schedule can make after generation, in caller-owned transactions.

Generation writes a draft (`SchedulingService.store_draft`). What happens to it afterwards is a
lifecycle question, not a scheduling one: a draft is disposable until a manager confirms it, a
confirmed schedule is the record of what the floor was told to do, and a confirmed schedule the
floor never acted on can be withdrawn and later restored (decision 0015). This module holds the
transitions; the API owns the transaction, per docs/backend-conventions.md.

Every transition locks the schedule row first, so two of them on the same schedule cannot
interleave: whichever runs second sees the other's result.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.schedule import (
    SCHEDULE_CONFIRMED,
    SCHEDULE_DISCARDED,
    SCHEDULE_DRAFT,
    Schedule,
    ScheduleStatus,
)
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.database.models.simulation_event import SimulationEvent
from floorsync_common.outcomes import ExpectedOutcome


@dataclass(frozen=True, slots=True)
class ScheduleDeleted:
    schedule_id: UUID


@dataclass(frozen=True, slots=True)
class ScheduleNotFound(ExpectedOutcome):
    schedule_id: UUID


@dataclass(frozen=True, slots=True)
class ScheduleNotDraft(ExpectedOutcome):
    """The schedule has left the draft state, so it is history and cannot be deleted.

    A confirmed schedule is what the floor was, or will be, told to do, and a discarded one is a
    confirmed schedule that was withdrawn; both are records. `simulations.schedule_id` restricts
    deletion behind this check for the same reason.
    """

    schedule_id: UUID
    status: ScheduleStatus


@dataclass(frozen=True, slots=True)
class ScheduleConfirmed:
    """The schedule is now the plan. Also the result of restoring a discarded one."""

    schedule: Schedule


@dataclass(frozen=True, slots=True)
class ScheduleDiscarded:
    """The schedule was withdrawn. It stays, as a record that it was once the plan."""

    schedule: Schedule


@dataclass(frozen=True, slots=True)
class JobPlannedElsewhere:
    """One job the schedule plans that another confirmed schedule already plans."""

    job_id: UUID
    schedule_id: UUID
    schedule_name: str | None


@dataclass(frozen=True, slots=True)
class ScheduleJobsAlreadyPlanned(ExpectedOutcome):
    """Confirming would put a job in two plans at once, so the manager has to withdraw one first.

    A planned job may be drafted again (an alternative plan is worth comparing), but only one
    confirmed schedule may claim it: two would each be "the plan" and each could be simulated.
    `conflicts` names every such job with the confirmed schedule holding it, ordered by job then
    schedule.
    """

    schedule_id: UUID
    conflicts: tuple[JobPlannedElsewhere, ...]


@dataclass(frozen=True, slots=True)
class ScheduleRenamed:
    schedule: Schedule


@dataclass(frozen=True, slots=True)
class ScheduleIsDraft(ExpectedOutcome):
    """A draft cannot be discarded, because `discarded` means "was the plan, then withdrawn".

    A draft that is no longer wanted is deleted (`delete_draft`), which also frees the jobs it
    planned; discarding it would keep blocking their edits for no reason.
    """

    schedule_id: UUID


@dataclass(frozen=True, slots=True)
class ScheduleSimulationStarted(ExpectedOutcome):
    """The floor has begun acting on this schedule, so it can no longer be withdrawn.

    "Begun" means its simulation has at least one control event. A simulation that was created
    and never started is not evidence of anything and is removed with the withdrawal.
    """

    schedule_id: UUID
    simulation_id: UUID
    simulation_status: str


type DeleteScheduleResult = ScheduleDeleted | ScheduleNotFound | ScheduleNotDraft
type ConfirmScheduleResult = ScheduleConfirmed | ScheduleNotFound | ScheduleJobsAlreadyPlanned
type RenameScheduleResult = ScheduleRenamed | ScheduleNotFound
type DiscardScheduleResult = (
    ScheduleDiscarded | ScheduleNotFound | ScheduleIsDraft | ScheduleSimulationStarted
)


class ScheduleLifecycleService:
    """Stateless transitions on stored schedules."""

    @staticmethod
    async def delete_draft(db: AsyncSession, schedule_id: UUID) -> DeleteScheduleResult:
        """Remove a draft schedule outright, with everything that hung off it.

        A hard delete rather than a status flip: `schedule_entries.operation_id` restricts deleting
        an operation regardless of its schedule's status, so a draft that merely changed status
        would keep blocking edits to the jobs it planned, which is the whole reason a manager wants
        rid of it. Nothing about a draft is a record -- nobody confirmed it -- so nothing is lost.

        Entries are deleted explicitly because their FK to `schedules` is RESTRICT by design;
        `schedule_dependencies` cascade from the entries and `schedule_job_selections` from the
        schedule. The row is locked first so this cannot interleave with a confirmation of the same
        draft: whichever runs second sees the other's result.
        """

        schedule = await db.scalar(
            select(Schedule).where(Schedule.id == schedule_id).with_for_update()
        )
        if schedule is None:
            return ScheduleNotFound(schedule_id=schedule_id)
        if schedule.status != SCHEDULE_DRAFT:
            return ScheduleNotDraft(schedule_id=schedule_id, status=schedule.status)

        await db.execute(delete(ScheduleEntry).where(ScheduleEntry.schedule_id == schedule_id))
        await db.delete(schedule)
        await db.flush()
        return ScheduleDeleted(schedule_id=schedule_id)

    @staticmethod
    async def confirm(
        db: AsyncSession, schedule_id: UUID, *, confirmed_by: UUID, at: datetime | None = None
    ) -> ConfirmScheduleResult:
        """Make a draft the plan, or make a withdrawn plan the plan again.

        Records who confirmed it and when. A schedule that is already confirmed is left exactly
        as it is, original confirmer and timestamp included, so a repeated request cannot rewrite
        the audit trail. Confirming touches no job: what a plan claims is read from its entries
        (#269), not written onto the jobs.

        Refused while another confirmed schedule plans any of the same jobs. The jobs' rows are
        locked first, in id order, so two confirmations sharing a job serialise and the second sees
        the first as a conflict instead of both slipping through as drafts.
        """

        schedule = await db.scalar(
            select(Schedule).where(Schedule.id == schedule_id).with_for_update()
        )
        if schedule is None:
            return ScheduleNotFound(schedule_id=schedule_id)
        if schedule.status == SCHEDULE_CONFIRMED:
            return ScheduleConfirmed(schedule=schedule)

        planned_job_ids = (
            select(Operation.job_id)
            .join(ScheduleEntry, ScheduleEntry.operation_id == Operation.id)
            .where(ScheduleEntry.schedule_id == schedule_id)
        )
        await db.execute(
            select(Job.id).where(Job.id.in_(planned_job_ids)).order_by(Job.id).with_for_update()
        )
        conflicts = (
            await db.execute(
                select(Operation.job_id, Schedule.id, Schedule.name)
                .select_from(ScheduleEntry)
                .join(Operation, Operation.id == ScheduleEntry.operation_id)
                .join(Schedule, Schedule.id == ScheduleEntry.schedule_id)
                .where(
                    Schedule.status == SCHEDULE_CONFIRMED,
                    Schedule.id != schedule_id,
                    Operation.job_id.in_(planned_job_ids),
                )
                .distinct()
                .order_by(Operation.job_id, Schedule.id)
            )
        ).all()
        if conflicts:
            return ScheduleJobsAlreadyPlanned(
                schedule_id=schedule_id,
                conflicts=tuple(
                    JobPlannedElsewhere(job_id=job_id, schedule_id=other_id, schedule_name=name)
                    for job_id, other_id, name in conflicts
                ),
            )

        schedule.status = SCHEDULE_CONFIRMED
        schedule.confirmed_by_user_id = confirmed_by
        schedule.confirmed_at = at or datetime.now(UTC)
        await db.flush()
        return ScheduleConfirmed(schedule=schedule)

    @staticmethod
    async def rename(db: AsyncSession, schedule_id: UUID, name: str) -> RenameScheduleResult:
        """Give a schedule the name a manager chose, in whatever status it is in.

        A name labels the run; it changes nothing the schedule planned, so unlike the transitions
        above it is allowed on a confirmed or discarded schedule too. Locked like them, so a rename
        sent alongside a transition sees that transition's result.
        """

        schedule = await db.scalar(
            select(Schedule).where(Schedule.id == schedule_id).with_for_update()
        )
        if schedule is None:
            return ScheduleNotFound(schedule_id=schedule_id)

        schedule.name = name
        await db.flush()
        return ScheduleRenamed(schedule=schedule)

    @staticmethod
    async def discard(db: AsyncSession, schedule_id: UUID) -> DiscardScheduleResult:
        """Withdraw a confirmed schedule the floor has not acted on.

        The row stays with its confirmation details, because it was once the plan and that is
        worth remembering; only its status changes. A simulation that was created for it but never
        controlled is removed in the same transaction, since it records nothing and would
        otherwise block the withdrawal through `simulations.schedule_id`. A simulation with any
        event is the floor acting on the plan, and the withdrawal is refused.
        """

        schedule = await db.scalar(
            select(Schedule).where(Schedule.id == schedule_id).with_for_update()
        )
        if schedule is None:
            return ScheduleNotFound(schedule_id=schedule_id)
        if schedule.status == SCHEDULE_DRAFT:
            return ScheduleIsDraft(schedule_id=schedule_id)
        if schedule.status == SCHEDULE_DISCARDED:
            return ScheduleDiscarded(schedule=schedule)

        simulation = await db.scalar(
            select(Simulation).where(Simulation.schedule_id == schedule_id)
        )
        if simulation is not None:
            started = await db.scalar(
                select(SimulationEvent.id)
                .where(SimulationEvent.simulation_id == simulation.id)
                .limit(1)
            )
            if started is not None:
                return ScheduleSimulationStarted(
                    schedule_id=schedule_id,
                    simulation_id=simulation.id,
                    simulation_status=simulation.status,
                )
            await db.delete(simulation)

        schedule.status = SCHEDULE_DISCARDED
        await db.flush()
        return ScheduleDiscarded(schedule=schedule)
