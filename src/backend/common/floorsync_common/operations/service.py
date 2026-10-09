"""Operation and ordering persistence with caller-owned transactions.

Nothing here commits or rolls back: the route owns the transaction boundary, per
docs/backend-conventions.md.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.jobs.guards import refuse_unless_open
from floorsync_common.jobs.results import JobHasLeftBacklog, JobNotFound
from floorsync_common.operations.graph import find_dependency_cycle
from floorsync_common.operations.results import (
    CreateOperationResult,
    DeleteOperationResult,
    DependencyCycle,
    GetOperationResult,
    JobDependenciesListed,
    JobDependenciesReplaced,
    ListJobDependenciesResult,
    OperationCreated,
    OperationDeleted,
    OperationFound,
    OperationIsScheduled,
    OperationNotFound,
    OperationNotInJob,
    OperationUpdated,
    ReplaceJobDependenciesResult,
    UpdateOperationResult,
)
from floorsync_common.partial import UNSET, Unset, is_set
from floorsync_common.scheduling.references import find_schedule_references


@dataclass(frozen=True, slots=True)
class DependencyEdge:
    """One proposed ordering edge, before the database has seen it.

    A plain domain value rather than the HTTP schema, because an API contract must not reach the
    service layer. See docs/backend-conventions.md.
    """

    before_operation_id: UUID
    after_operation_id: UUID


class OperationService:
    """Stateless persistence for the steps inside a job."""

    @staticmethod
    async def create_operation(
        db: AsyncSession,
        job_id: UUID,
        *,
        name: str,
    ) -> CreateOperationResult:
        """Add a step to a job.

        Operation names are deliberately not unique, for the same reason job names are not: two
        steps can both legitimately read "Cut to length", and the identifier that has to be unique
        is the primary key the database assigns.
        """

        job = await db.get(Job, job_id)
        if job is None:
            return JobNotFound(job_id=job_id)
        refused = await refuse_unless_open(db, job)
        if refused is not None:
            return refused

        # A step added on its own goes to the end of the job. The unique constraint on
        # (job_id, position) is what holds under two such adds racing for the same slot.
        last_position = await db.scalar(
            select(func.coalesce(func.max(Operation.position), 0)).where(Operation.job_id == job_id)
        )
        operation = Operation(job_id=job_id, name=name.strip(), position=(last_position or 0) + 1)
        db.add(operation)
        await db.flush()
        return OperationCreated(operation=operation)

    @staticmethod
    async def get_operation(db: AsyncSession, operation_id: UUID) -> GetOperationResult:
        """Read one operation with its machine options and its place in the ordering.

        The same capability rows are reachable from each machine, but only machine-first: answering
        "what can run this step, and how long does each take" from there means reading every
        machine on the floor. This is the operation-first view the job editor needs.
        """

        operation = await db.get(Operation, operation_id)
        if operation is None:
            return OperationNotFound(operation_id=operation_id)

        compatibilities = (
            await db.scalars(
                select(Compatibility)
                .where(Compatibility.operation_id == operation_id)
                .order_by(Compatibility.machine_id)
            )
        ).all()
        predecessors = (
            await db.scalars(
                select(Dependency)
                .where(Dependency.after_operation_id == operation_id)
                .order_by(Dependency.before_operation_id)
            )
        ).all()
        successors = (
            await db.scalars(
                select(Dependency)
                .where(Dependency.before_operation_id == operation_id)
                .order_by(Dependency.after_operation_id)
            )
        ).all()

        return OperationFound(
            operation=operation,
            compatibilities=tuple(compatibilities),
            predecessors=tuple(predecessors),
            successors=tuple(successors),
        )

    @staticmethod
    async def update_operation(
        db: AsyncSession,
        operation_id: UUID,
        *,
        name: str | Unset = UNSET,
    ) -> UpdateOperationResult:
        """Apply a partial update, leaving omitted fields untouched."""

        operation = await db.get(Operation, operation_id)
        if operation is None:
            return OperationNotFound(operation_id=operation_id)
        refused = await OperationService._left_backlog(db, operation)
        if refused is not None:
            return refused

        if is_set(name):
            operation.name = name.strip()

        await db.flush()
        return OperationUpdated(operation=operation)

    @staticmethod
    async def _left_backlog(db: AsyncSession, operation: Operation) -> JobHasLeftBacklog | None:
        """The refusal a job that is not open gives every edit to its steps, or None.

        A separate read rather than `operation.job`: the relationship is lazy and async code
        cannot await it during attribute access.
        """

        job = await db.get(Job, operation.job_id)
        if job is None:
            return None
        return await refuse_unless_open(db, job)

    @staticmethod
    async def delete_operation(db: AsyncSession, operation_id: UUID) -> DeleteOperationResult:
        """Remove a step, unless it already appears in a schedule.

        Its compatibilities and ordering edges cascade from it -- none of them mean anything without
        the operation. Schedule entries do not: they record what was actually planned, so the
        database restricts the delete and this checks first to give a reason rather than an
        integrity error. See the deletion policy in docs/database-schema.md.
        """

        operation = await db.get(Operation, operation_id)
        if operation is None:
            return OperationNotFound(operation_id=operation_id)
        refused = await OperationService._left_backlog(db, operation)
        if refused is not None:
            return refused

        references = await find_schedule_references(db, operation_ids=(operation_id,))
        if references:
            return OperationIsScheduled(operation_id=operation_id, references=references)

        job_id, position = operation.job_id, operation.position
        await db.delete(operation)
        await db.flush()
        # Close the gap so the job's positions stay 1..N, which is what the builder shows and what
        # a later definition save expects to find. The deferred unique constraint lets the shift
        # be one statement: checked immediately, moving 3 to 2 would collide with the 2 that had
        # not yet moved to 1.
        await db.execute(
            update(Operation)
            .where(Operation.job_id == job_id, Operation.position > position)
            .values(position=Operation.position - 1)
        )
        return OperationDeleted(operation_id=operation_id)


class DependencyService:
    """Stateless persistence for the order a job's steps run in.

    A job's ordering is every edge whose `after_operation` belongs to that job -- what the steps in
    this job wait on. The `before` side may live in another job, which the schema allows on purpose
    (#125). Defining ownership by the `after` side gives every edge exactly one owning job, so the
    whole-graph replace below can express any edge that exists and two jobs saved at the same time
    can never contend for the same row.
    """

    @staticmethod
    async def list_job_dependencies(db: AsyncSession, job_id: UUID) -> ListJobDependenciesResult:
        """Read a job's ordering, separating "no such job" from "nothing ordered yet"."""

        if await db.get(Job, job_id) is None:
            return JobNotFound(job_id=job_id)

        return JobDependenciesListed(
            dependencies=await DependencyService._load_job_dependencies(db, job_id)
        )

    @staticmethod
    async def replace_job_dependencies(
        db: AsyncSession,
        job_id: UUID,
        *,
        edges: Sequence[DependencyEdge],
    ) -> ReplaceJobDependenciesResult:
        """Replace a job's ordering wholesale, in the caller's single transaction.

        Reordering is inherently a multi-edge change. Applied one edge at a time it would pass
        through intermediate graphs that may themselves be cyclic, and a failure part-way would
        leave an order nobody asked for. So the caller sends the ordering it wants and this swaps it
        in, which also turns the cycle check into one question about one graph.

        Editing the ordering of a job that is already scheduled is allowed, deliberately.
        `schedule_dependencies` is a per-schedule copy rebuilt at generation (#125), so an existing
        schedule keeps its own record of what it was generated from and a later change here cannot
        rewrite that history.
        """

        job = await db.get(Job, job_id)
        if job is None:
            return JobNotFound(job_id=job_id)
        refused = await refuse_unless_open(db, job)
        if refused is not None:
            return refused

        owned = set(
            (await db.scalars(select(Operation.id).where(Operation.job_id == job_id))).all()
        )

        for edge in edges:
            if edge.after_operation_id not in owned:
                return OperationNotInJob(operation_id=edge.after_operation_id, job_id=job_id)

        # Only predecessors outside this job need looking up; the rest are already known to exist.
        external = {edge.before_operation_id for edge in edges} - owned
        if external:
            known = set(
                (await db.scalars(select(Operation.id).where(Operation.id.in_(external)))).all()
            )
            unknown = sorted(external - known)
            if unknown:
                return OperationNotFound(operation_id=unknown[0])

        # Cycles are checked across the whole graph, not this job's slice of it, because cross-job
        # edges are deliberately allowed and a cycle can therefore span jobs.
        retained = (
            await db.scalars(select(Dependency).where(Dependency.after_operation_id.notin_(owned)))
        ).all()
        cycle = find_dependency_cycle(
            [(edge.before_operation_id, edge.after_operation_id) for edge in retained]
            + [(edge.before_operation_id, edge.after_operation_id) for edge in edges]
        )
        if cycle:
            return DependencyCycle(operation_ids=cycle)

        await db.execute(delete(Dependency).where(Dependency.after_operation_id.in_(owned)))
        db.add_all(
            [
                Dependency(
                    before_operation_id=edge.before_operation_id,
                    after_operation_id=edge.after_operation_id,
                )
                for edge in edges
            ]
        )
        await db.flush()

        return JobDependenciesReplaced(
            dependencies=await DependencyService._load_job_dependencies(db, job_id)
        )

    @staticmethod
    async def _load_job_dependencies(db: AsyncSession, job_id: UUID) -> tuple[Dependency, ...]:
        """Read the edges this job owns: those whose `after` operation belongs to it."""

        dependencies = (
            await db.scalars(
                select(Dependency)
                .join(Operation, Operation.id == Dependency.after_operation_id)
                .where(Operation.job_id == job_id)
                .order_by(Dependency.before_operation_id, Dependency.after_operation_id)
            )
        ).all()
        return tuple(dependencies)


# `find_dependency_cycle` lives in `operations.graph` and is re-exported here so existing
# importers keep working; new code should import it from `graph` directly.
__all__ = ["DependencyEdge", "DependencyService", "OperationService", "find_dependency_cycle"]
