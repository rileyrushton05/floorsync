"""Job persistence with caller-owned transactions.

Nothing here commits or rolls back: the route owns the transaction boundary, per
docs/backend-conventions.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import Select, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.jobs.dependency_graph import JobEdge, job_dependency_edges_statement
from floorsync_common.jobs.guards import refuse_unless_open
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
from floorsync_common.scheduling.references import find_schedule_references


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
        include_archived: bool = False,
    ) -> JobPage:
        """Read one page of jobs ordered by name, with id as the tie-breaker.

        The tie-breaker carries real weight here, unlike for machines: job names are not unique, so
        name alone would not be a total order and a page boundary could repeat or skip a row.

        Archived jobs are left out unless asked for: the list is the backlog, and a job that has
        finished or been cancelled is exactly what the backlog should no longer offer.
        """

        statement: Select[tuple[Job]] = select(Job).order_by(Job.name, Job.id)
        if not include_archived:
            statement = statement.where(Job.archived_at.is_(None))
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
        archived: Literal[True] | Unset = UNSET,
    ) -> UpdateJobResult:
        """Apply a partial update, leaving omitted fields untouched.

        `archived: true` is the manager's way to retire an unplanned job by hand, a cancelled one
        or one that finished without a plan. It stamps `archived_at` now and leaves an earlier
        stamp alone, so the original leaving time survives a repeated request. Archiving never
        touches schedules, and never makes a job deletable (decision 0015).

        Only an open job can be changed (decisions 0018, 0019). A planned, done or archived job
        accepts nothing but `archived: true`: archiving a planned job is how a manager cancels it,
        and repeating it on an archived one is a harmless no-op, so a stale form cannot rename
        either. Archiving is one way; a planned job comes back when its schedule is discarded.
        """

        job = await db.get(Job, job_id)
        if job is None:
            return JobNotFound(job_id=job_id)

        if is_set(name):
            refused = await refuse_unless_open(db, job)
            if refused is not None:
                return refused

        if is_set(name):
            job.name = name.strip()
        if is_set(archived) and job.archived_at is None:
            job.archived_at = datetime.now(UTC)

        await db.flush()
        return JobUpdated(job=job)

    @staticmethod
    async def delete_job(db: AsyncSession, job_id: UUID) -> DeleteJobResult:
        """Remove a job and its operations, unless its work already appears in a schedule.

        Operations, their compatibilities and their dependencies cascade from the job. Schedule
        entries do not: they record what was actually planned, so the database restricts the delete
        and this checks first to give a reason rather than an integrity error. The refusal names
        the schedules, because what the caller can do next depends on them: a draft can be deleted
        and the job removed afterwards; a confirmed schedule cannot, and the job is archived
        instead (decision 0015).
        """

        job = await db.get(Job, job_id)
        if job is None:
            return JobNotFound(job_id=job_id)

        references = await find_schedule_references(db, job_id=job_id)
        if references:
            return JobIsScheduled(job_id=job_id, references=references)

        await db.delete(job)
        await db.flush()
        return JobDeleted(job_id=job_id)
