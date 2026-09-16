"""Transitions a stored schedule can make after generation, in caller-owned transactions.

Generation writes a draft (`SchedulingService.store_draft`). What happens to it afterwards is a
lifecycle question, not a scheduling one: a draft is disposable until a manager confirms it, and a
confirmed schedule is the record of what the floor was told to do (decision 0015). This module holds
the transitions; the API owns the transaction, per docs/backend-conventions.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.schedule import Schedule, ScheduleStatus
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.outcomes import ExpectedOutcome
from floorsync_common.scheduling.references import SCHEDULE_DRAFT


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


type DeleteScheduleResult = ScheduleDeleted | ScheduleNotFound | ScheduleNotDraft


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
