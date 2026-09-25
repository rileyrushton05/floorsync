"""Where a job stands in the backlog, derived from the schedules that reference it (#269).

The backlog is the work no plan has claimed. That is not a fact stored on the job: a job is
"planned" because a confirmed schedule has entries for its operations, and "done" because that
schedule's simulation completed. Both are already recorded on the schedule side, so writing them
onto `jobs` as well would be a second source of truth that goes stale the moment a schedule is
withdrawn (decision 0019). The one thing the job row does say is `archived_at`: a manager retired
it by hand.

Everything here is pure except the one statement builder, so the API (which shows the status) and
the scheduling service (which refuses to plan a claimed job again) read the same answer.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import ColumnElement, Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.schedule import SCHEDULE_CONFIRMED, Schedule
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.simulation import SIMULATION_COMPLETE, Simulation

type BacklogStatus = Literal["open", "planned", "done", "archived"]
"""`open`: no confirmed schedule plans the job. `planned`: at least one does. `done`: one of those
schedules has a completed simulation. `archived`: a manager retired it by hand, whatever the
schedules say."""

type PlanRow = tuple[UUID, UUID, str | None]
"""One (job_id, schedule_id, simulation_status) row: a confirmed schedule that plans the job, and
the status of its simulation if one exists."""


@dataclass(frozen=True, slots=True)
class JobBacklog:
    """A job's backlog status and the confirmed schedules that plan it, oldest first."""

    status: BacklogStatus
    schedule_ids: tuple[UUID, ...]


OPEN = JobBacklog(status="open", schedule_ids=())
"""What a job nobody has planned reports, including one created a moment ago."""


def planned_jobs_statement(job_ids: Collection[UUID]) -> Select[PlanRow]:
    """Select, for each of `job_ids`, every confirmed schedule that plans it and its simulation.

    A schedule plans a job when it has an entry for any of the job's operations. Drafts are
    proposals and discarded schedules were withdrawn, so neither claims a job. One row per planned
    operation rather than DISTINCT, so the rows can be ordered by when the plan was made (Postgres
    will not order a DISTINCT result by a column it does not return); `derive_backlog` folds the
    repeats.
    """

    # The outer join makes `Simulation.status` nullable; the mapped column does not know that.
    simulation_status = cast(ColumnElement[str | None], Simulation.status)
    return (
        select(Operation.job_id, Schedule.id, simulation_status)
        .select_from(ScheduleEntry)
        .join(Operation, Operation.id == ScheduleEntry.operation_id)
        .join(Schedule, Schedule.id == ScheduleEntry.schedule_id)
        .outerjoin(Simulation, Simulation.schedule_id == Schedule.id)
        .where(Schedule.status == SCHEDULE_CONFIRMED, Operation.job_id.in_(job_ids))
        .order_by(Schedule.created_at, Schedule.id, Operation.job_id)
    )


def planned_job_ids_statement() -> Select[tuple[UUID]]:
    """Select the id of every job some confirmed schedule plans, for use as a subquery."""

    return (
        select(Operation.job_id)
        .select_from(ScheduleEntry)
        .join(Operation, Operation.id == ScheduleEntry.operation_id)
        .join(Schedule, Schedule.id == ScheduleEntry.schedule_id)
        .where(Schedule.status == SCHEDULE_CONFIRMED)
        .distinct()
    )


def derive_backlog(
    jobs: Iterable[tuple[UUID, datetime | None]], plans: Iterable[PlanRow]
) -> dict[UUID, JobBacklog]:
    """Turn `(job_id, archived_at)` pairs and the plan rows into one status per job.

    Every job in `jobs` gets an answer, `OPEN` when nothing plans it. `archived` wins over the
    schedules because it is the manager's explicit word about the job; `done` wins over `planned`
    because the floor having run the work is the stronger fact. Total and order-independent.
    """

    planned: dict[UUID, list[UUID]] = {}
    done: set[UUID] = set()
    for job_id, schedule_id, simulation_status in plans:
        schedules = planned.setdefault(job_id, [])
        if schedule_id not in schedules:
            schedules.append(schedule_id)
        if simulation_status == SIMULATION_COMPLETE:
            done.add(job_id)

    result: dict[UUID, JobBacklog] = {}
    for job_id, archived_at in jobs:
        schedule_ids = tuple(planned.get(job_id, ()))
        status: BacklogStatus
        if archived_at is not None:
            status = "archived"
        elif job_id in done:
            status = "done"
        elif schedule_ids:
            status = "planned"
        else:
            status = "open"
        result[job_id] = JobBacklog(status=status, schedule_ids=schedule_ids)
    return result


class BacklogService:
    """Read backlog status for jobs the caller already holds. Stateless."""

    @staticmethod
    async def load(db: AsyncSession, jobs: Collection[Job]) -> Mapping[UUID, JobBacklog]:
        """One bulk read for any number of jobs, never one per row."""

        if not jobs:
            return {}
        plans = (await db.execute(planned_jobs_statement([job.id for job in jobs]))).tuples().all()
        return derive_backlog(((job.id, job.archived_at) for job in jobs), plans)


__all__ = [
    "OPEN",
    "BacklogService",
    "BacklogStatus",
    "JobBacklog",
    "PlanRow",
    "derive_backlog",
    "planned_job_ids_statement",
    "planned_jobs_statement",
]
