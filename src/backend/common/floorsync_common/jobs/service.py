"""Job persistence with caller-owned transactions.

Nothing here commits or rolls back: the route owns the transaction boundary, per
docs/backend-conventions.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import Select, exists, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.jobs.dependency_graph import JobEdge, job_dependency_edges_statement
from floorsync_common.jobs.results import (
    DeleteJobResult,
    GetJobResult,
    JobDeleted,
    JobFound,
    JobIsScheduled,
    JobNotFound,
    JobUpdated,
    UpdateJobResult,
)
from floorsync_common.pagination import decode_cursor, encode_cursor
from floorsync_common.partial import UNSET, Unset, is_set


@dataclass(frozen=True, slots=True)
class JobPage:
    """One page of jobs, with the cursor that reads the next one."""

    jobs: tuple[Job, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class JobDependencyGraph:
    """Every job-level precedence edge in the backlog, as (before_job_id, after_job_id) pairs."""

    edges: tuple[JobEdge, ...]


class JobService:
    """Stateless job operations."""

    @staticmethod
    async def create_job(db: AsyncSession, *, name: str) -> Job:
        """Add a job.

        Job names are deliberately not unique: two real jobs can both be "Repair conveyor", and the
        identifier that has to be unique is the primary key, which the database assigns. Priority
        is left to its database default here; nothing yet lets a caller set it (#235).
        """

        job = Job(name=name.strip())
        db.add(job)
        await db.flush()
        return job

    @staticmethod
    async def get_job(db: AsyncSession, job_id: UUID) -> GetJobResult:
        """Read one job together with the operations it contains, in their stored order."""

        job = await db.get(Job, job_id)
        if job is None:
            return JobNotFound(job_id=job_id)

        operations = (
            await db.scalars(
                select(Operation).where(Operation.job_id == job_id).order_by(Operation.position)
            )
        ).all()
        return JobFound(job=job, operations=tuple(operations))

    @staticmethod
    async def list_jobs(
        db: AsyncSession,
        *,
        limit: int = 50,
        cursor: str | None = None,
    ) -> JobPage:
        """Read one page of jobs ordered by name, with id as the tie-breaker.

        The tie-breaker carries real weight here, unlike for machines: job names are not unique, so
        name alone would not be a total order and a page boundary could repeat or skip a row.
        """

        statement: Select[tuple[Job]] = select(Job).order_by(Job.name, Job.id)
        position = decode_cursor(cursor)
        if position is not None:
            statement = statement.where(tuple_(Job.name, Job.id) > position)

        rows = (await db.scalars(statement.limit(limit + 1))).all()
        page = tuple(rows[:limit])
        next_cursor = (
            encode_cursor(page[-1].name, page[-1].id) if len(rows) > limit and page else None
        )
        return JobPage(jobs=page, next_cursor=next_cursor)

    @staticmethod
    async def list_dependency_graph(db: AsyncSession) -> JobDependencyGraph:
        """Read which jobs wait on which, derived from the operation-level edges (#231).

        Unpaginated on purpose: a job's prerequisites are not confined to any one page of
        `list_jobs`, and the result is one row per cross-job edge, of which there are usually none.
        No expected failure -- an empty backlog is an empty graph, not an error.
        """

        rows = (await db.execute(job_dependency_edges_statement())).tuples().all()
        return JobDependencyGraph(edges=tuple(rows))

    @staticmethod
    async def update_job(
        db: AsyncSession,
        job_id: UUID,
        *,
        name: str | Unset = UNSET,
    ) -> UpdateJobResult:
        """Apply a partial update, leaving omitted fields untouched."""

        job = await db.get(Job, job_id)
        if job is None:
            return JobNotFound(job_id=job_id)

        if is_set(name):
            job.name = name.strip()

        await db.flush()
        # `updated_at` is database-computed through `onupdate`, so an UPDATE expires it and reading
        # it during serialisation would need a lazy reload that async SQLAlchemy cannot await.
        await db.refresh(job)
        return JobUpdated(job=job)

    @staticmethod
    async def delete_job(db: AsyncSession, job_id: UUID) -> DeleteJobResult:
        """Remove a job and its operations, unless its work already appears in a schedule.

        Operations, their compatibilities and their dependencies cascade from the job. Schedule
        entries do not: they record what was actually planned, so the database restricts the delete
        and this checks first to give a reason rather than an integrity error.
        """

        job = await db.get(Job, job_id)
        if job is None:
            return JobNotFound(job_id=job_id)

        scheduled = await db.scalar(
            select(
                exists().where(
                    ScheduleEntry.operation_id == Operation.id,
                    Operation.job_id == job_id,
                )
            )
        )
        if scheduled:
            return JobIsScheduled(job_id=job_id)

        await db.delete(job)
        await db.flush()
        return JobDeleted(job_id=job_id)
