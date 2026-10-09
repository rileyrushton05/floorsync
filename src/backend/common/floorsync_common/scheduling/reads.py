"""Read stored schedules, in caller-owned transactions.

Generation writes a schedule (`SchedulingService.store_draft`) and `lifecycle` moves it between
statuses; this module only reads one back, for the schedules API.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.schedule import Schedule
from floorsync_common.database.models.schedule_dependency import ScheduleDependency
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.schedule_job_selection import ScheduleJobSelection
from floorsync_common.scheduling.lifecycle import ScheduleNotFound


@dataclass(frozen=True, slots=True)
class ScheduleFound:
    """One schedule with everything it planned, and the jobs it was asked to plan.

    `job_ids` is `None` for a schedule made for the whole floor: a seeded one, or one generated
    before generation took a selection (#231). See `ScheduleJobSelection`.
    """

    schedule: Schedule
    entries: tuple[ScheduleEntry, ...]
    dependencies: tuple[ScheduleDependency, ...]
    job_ids: tuple[UUID, ...] | None


type GetScheduleResult = ScheduleFound | ScheduleNotFound


class ScheduleReadService:
    """Stateless reads of stored schedules."""

    @staticmethod
    async def list_schedules(db: AsyncSession) -> tuple[Schedule, ...]:
        """Every schedule, newest first, without its entries."""

        schedules = await db.scalars(
            select(Schedule).order_by(Schedule.created_at.desc(), Schedule.id.desc())
        )
        return tuple(schedules.all())

    @staticmethod
    async def get_schedule(db: AsyncSession, schedule_id: UUID) -> GetScheduleResult:
        """One schedule with its entries, dependency graph and job selection, each in id order."""

        schedule = await db.get(Schedule, schedule_id)
        if schedule is None:
            return ScheduleNotFound(schedule_id=schedule_id)

        entries = await db.scalars(
            select(ScheduleEntry)
            .where(ScheduleEntry.schedule_id == schedule_id)
            .order_by(ScheduleEntry.id)
        )
        dependencies = await db.scalars(
            select(ScheduleDependency)
            .join(ScheduleEntry, ScheduleDependency.schedule_entry_id == ScheduleEntry.id)
            .where(ScheduleEntry.schedule_id == schedule_id)
            .order_by(ScheduleDependency.id)
        )
        job_ids = await db.scalars(
            select(ScheduleJobSelection.job_id)
            .where(ScheduleJobSelection.schedule_id == schedule_id)
            .order_by(ScheduleJobSelection.job_id)
        )
        return ScheduleFound(
            schedule=schedule,
            entries=tuple(entries.all()),
            dependencies=tuple(dependencies.all()),
            # No rows means the whole floor, never an empty selection: generation refuses one.
            job_ids=tuple(job_ids.all()) or None,
        )
