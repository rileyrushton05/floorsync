"""Which schedules have planned a piece of work, split by whether they can still be discarded.

A `schedule_entries` row is a schedule's record that it planned an operation. Removing the
operation, or its job, would leave that record pointing at nothing, so the database restricts the
delete and the services refuse first. What the caller can do about it depends on the schedule's
status (decision 0015): a draft is disposable and can be deleted, after which the removal goes
through; a confirmed schedule is history and blocks the removal for good. Refusals therefore name
both sets, so a client can offer "discard these drafts and retry" only when that would work.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.schedule import SCHEDULE_DRAFT, Schedule
from floorsync_common.database.models.schedule_entry import ScheduleEntry

"""The one status a schedule can be deleted in; shared with `lifecycle.py` rather than restated."""


@dataclass(frozen=True, slots=True)
class ScheduleReferences:
    """The schedules whose entries point at the work in question, by what can be done about them.

    `confirmed_schedule_ids` holds every non-draft schedule, discarded ones included: neither can be
    deleted through the API, so for the caller they are the same obstacle.
    """

    draft_schedule_ids: tuple[UUID, ...]
    confirmed_schedule_ids: tuple[UUID, ...]

    def __bool__(self) -> bool:
        return bool(self.draft_schedule_ids or self.confirmed_schedule_ids)


async def find_schedule_references(
    db: AsyncSession,
    *,
    operation_ids: Collection[UUID] | None = None,
    job_id: UUID | None = None,
) -> ScheduleReferences:
    """Find the schedules that planned any of `operation_ids`, or any operation of `job_id`.

    Exactly one of the two selectors is expected. Ids come back sorted so a refusal is stable
    between calls and between tests.
    """

    statement = (
        select(Schedule.id, Schedule.status)
        .join(ScheduleEntry, ScheduleEntry.schedule_id == Schedule.id)
        .distinct()
    )
    if job_id is not None:
        statement = statement.join(Operation, Operation.id == ScheduleEntry.operation_id).where(
            Operation.job_id == job_id
        )
    else:
        if not operation_ids:
            return ScheduleReferences(draft_schedule_ids=(), confirmed_schedule_ids=())
        statement = statement.where(ScheduleEntry.operation_id.in_(operation_ids))

    rows = (await db.execute(statement)).tuples().all()
    drafts = sorted(schedule_id for schedule_id, status in rows if status == SCHEDULE_DRAFT)
    others = sorted(schedule_id for schedule_id, status in rows if status != SCHEDULE_DRAFT)
    return ScheduleReferences(
        draft_schedule_ids=tuple(drafts), confirmed_schedule_ids=tuple(others)
    )
