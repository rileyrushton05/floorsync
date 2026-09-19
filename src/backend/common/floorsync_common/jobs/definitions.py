"""Atomic create, read and replace of a complete job-builder definition.

The builder edits a whole job -- its priority, its operations, and each operation's machine routes
-- in one request, never a route per operation or per edge. Piecemeal HTTP writes would allow
invalid intermediate states, such as an operation with no route at all. See #235.

API routers own `async with db.begin()`; every method here flushes but never commits or rolls
back, per docs/backend-conventions.md.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from itertools import pairwise
from uuid import UUID, uuid4

from sqlalchemy import Select, delete, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.job import Job, JobPriority
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.jobs.definition_results import (
    CreateDefinitionResult,
    DefinitionCreated,
    DefinitionFound,
    DefinitionReplaced,
    DefinitionsListed,
    GetDefinitionResult,
    InactiveMachine,
    JobDefinitionIsScheduled,
    JobDefinitionRead,
    OperationDoesNotBelongToJob,
    OperationHasExternalDependents,
    OperationWithRoutes,
    ReplaceDefinitionResult,
    UnknownMachine,
)
from floorsync_common.jobs.results import JobIsArchived, JobNotFound
from floorsync_common.operations.results import DependencyCycle
from floorsync_common.operations.service import find_dependency_cycle
from floorsync_common.pagination import decode_cursor, encode_cursor
from floorsync_common.scheduling.references import find_schedule_references


@dataclass(frozen=True, slots=True)
class BuilderRoute:
    """One operation-machine route, before the database has seen it."""

    machine_id: UUID
    duration_minutes: int
    energy: Decimal | None


@dataclass(frozen=True, slots=True)
class BuilderOperationCreate:
    name: str
    routes: tuple[BuilderRoute, ...]


@dataclass(frozen=True, slots=True)
class BuilderOperationReplace:
    """One operation in a replacement. `id` is `None` for a new operation."""

    id: UUID | None
    name: str
    routes: tuple[BuilderRoute, ...]


@dataclass(frozen=True, slots=True)
class JobDefinitionCreateCommand:
    name: str
    priority: JobPriority
    operations: tuple[BuilderOperationCreate, ...]


@dataclass(frozen=True, slots=True)
class JobDefinitionReplaceCommand:
    name: str
    priority: JobPriority
    operations: tuple[BuilderOperationReplace, ...]


@dataclass(frozen=True, slots=True)
class DefinitionPage:
    """One page of job definitions, with the cursor that reads the next one."""

    definitions: tuple[JobDefinitionRead, ...]
    next_cursor: str | None


class JobDefinitionService:
    """Stateless persistence for a complete builder definition."""

    @staticmethod
    async def create_definition(
        db: AsyncSession, command: JobDefinitionCreateCommand
    ) -> CreateDefinitionResult:
        """Create one job, its operations and their routes, or write nothing at all.

        Positions are assigned 1..N from the request's own order -- there is no caller-controlled
        position field, so the array index is the only representation of order.
        """

        machine_ids = {
            route.machine_id for operation in command.operations for route in operation.routes
        }
        invalid = await JobDefinitionService._validate_machines(db, machine_ids)
        if invalid is not None:
            return invalid

        job = Job(name=command.name.strip(), priority=command.priority)
        db.add(job)
        await db.flush()

        operations: list[Operation] = []
        for position, operation_command in enumerate(command.operations, start=1):
            operation = Operation(
                job_id=job.id, name=operation_command.name.strip(), position=position
            )
            db.add(operation)
            operations.append(operation)
        await db.flush()

        for operation, operation_command in zip(operations, command.operations, strict=True):
            for route in operation_command.routes:
                db.add(JobDefinitionService._new_compatibility(operation.id, route))
        db.add_all(JobDefinitionService._sequence_edges(operations))
        await db.flush()

        return DefinitionCreated(definition=await JobDefinitionService._load_definition(db, job.id))

    @staticmethod
    async def get_definition(db: AsyncSession, job_id: UUID) -> GetDefinitionResult:
        """Read one job's complete definition, for the builder to load into its editor."""

        job = await db.get(Job, job_id)
        if job is None:
            return JobNotFound(job_id=job_id)

        return DefinitionFound(definition=await JobDefinitionService._load_definition(db, job_id))

    @staticmethod
    async def list_definitions(
        db: AsyncSession,
        *,
        limit: int = 50,
        cursor: str | None = None,
        include_archived: bool = False,
    ) -> DefinitionsListed:
        """Read one page of job definitions ordered by name, with every operation and route.

        Fetches the page's nested data with two further bulk queries regardless of page size, so
        the frontend has no N+1 detail fetch. Archived jobs are left out unless asked for, the same
        reading `JobService.list_jobs` gives the backlog: they still exist and can still be read
        and edited one at a time, but they are not what the builder's list is for.
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
        if not page:
            return DefinitionsListed(definitions=(), next_cursor=None)

        operations_by_job = await JobDefinitionService._load_operations_by_job(
            db, [job.id for job in page]
        )
        return DefinitionsListed(
            definitions=tuple(
                JobDefinitionRead(job=job, operations=operations_by_job.get(job.id, ()))
                for job in page
            ),
            next_cursor=next_cursor,
        )

    @staticmethod
    async def replace_definition(
        db: AsyncSession, job_id: UUID, command: JobDefinitionReplaceCommand
    ) -> ReplaceDefinitionResult:
        """Replace a job's name, priority, operations and routes wholesale, atomically.

        Every check below runs, and can fail, before anything is written -- a failed save must
        leave every table exactly as it was. Refuses the whole save when: the job is archived
        (`JobIsArchived`, decision 0018: duplicate it instead); a supplied operation id
        belongs to another job; a route names an unknown or inactive machine; the save would
        remove an operation a generated schedule already recorded (every other edit is covered by
        the schedule's own snapshot, so a job that has been scheduled stays editable; see
        `JobDefinitionIsScheduled`); removing an omitted operation would cascade-delete an edge
        another job's own operation still depends on (`before_operation_id` may cross jobs by
        design, and `ON DELETE CASCADE` does not know that edge belongs to someone else); or the
        new ordering, together with every edge this save does not touch, would form a cycle.

        Once past those checks, this reconciles operations by id (update retained, add new, delete
        omitted -- deletion safely cascades that operation's own routes and ordering edges, since
        no schedule recorded it and no *other* job depends on it), replaces every retained/new
        operation's routes outright, and rebuilds only this job's `builder_sequence` ordering edges
        from the new order -- skipping a pair a retained edge of any origin already covers, since
        `(before_operation_id, after_operation_id)` is unique regardless of origin. Edges with any
        other origin are never deleted.
        """

        job = await db.scalar(select(Job).where(Job.id == job_id).with_for_update())
        if job is None:
            return JobNotFound(job_id=job_id)
        if job.archived_at is not None:
            return JobIsArchived(job_id=job_id, archived_at=job.archived_at)

        existing_operations = (
            await db.scalars(select(Operation).where(Operation.job_id == job_id))
        ).all()
        existing_by_id = {operation.id: operation for operation in existing_operations}

        for operation_command in command.operations:
            if operation_command.id is not None and operation_command.id not in existing_by_id:
                return OperationDoesNotBelongToJob(operation_id=operation_command.id, job_id=job_id)

        machine_ids = {
            route.machine_id for operation in command.operations for route in operation.routes
        }
        invalid = await JobDefinitionService._validate_machines(db, machine_ids)
        if invalid is not None:
            return invalid

        retained_ids = {
            operation_command.id
            for operation_command in command.operations
            if operation_command.id is not None
        }
        removed_ids = existing_by_id.keys() - retained_ids

        if removed_ids:
            # Scoped to the operations being removed, not to every operation the job has: a save
            # that keeps them all cannot touch anything a schedule recorded (#258).
            references = await find_schedule_references(db, operation_ids=removed_ids)
            if references:
                return JobDefinitionIsScheduled(job_id=job_id, references=references)
            blocked = await JobDefinitionService._find_external_dependent(db, job_id, removed_ids)
            if blocked is not None:
                return blocked

        # New operations' ids are assigned now, client-side, rather than left to the database's
        # default-on-flush -- the cycle check below needs every new ordering edge's real
        # endpoints before anything is written, and a new operation cannot yet be named by any
        # existing edge, so it can never itself be part of a cycle: only its assigned id matters.
        new_ids_by_index = {
            index: uuid4()
            for index, operation_command in enumerate(command.operations)
            if operation_command.id is None
        }
        ordered_ids = [
            operation_command.id if operation_command.id is not None else new_ids_by_index[index]
            for index, operation_command in enumerate(command.operations)
        ]
        new_sequence_edges = list(pairwise(ordered_ids))

        to_delete = (
            (
                await db.scalars(
                    select(Dependency).where(
                        Dependency.origin == "builder_sequence",
                        or_(
                            Dependency.before_operation_id.in_(existing_by_id.keys()),
                            Dependency.after_operation_id.in_(existing_by_id.keys()),
                        ),
                    )
                )
            ).all()
            if existing_by_id
            else ()
        )
        to_delete_ids = {dependency.id for dependency in to_delete}

        retained_statement = select(Dependency)
        if to_delete_ids:
            retained_statement = retained_statement.where(Dependency.id.notin_(to_delete_ids))
        retained_edges = (await db.scalars(retained_statement)).all()

        # `(before_operation_id, after_operation_id)` is unique regardless of origin, so a pair a
        # retained edge -- of any origin -- already covers must not be inserted again: the chain
        # only has to guarantee the ordering exists, not that this row in particular does.
        retained_pairs = {
            (edge.before_operation_id, edge.after_operation_id) for edge in retained_edges
        }
        new_sequence_edges = [pair for pair in new_sequence_edges if pair not in retained_pairs]

        cycle = find_dependency_cycle(
            [(edge.before_operation_id, edge.after_operation_id) for edge in retained_edges]
            + new_sequence_edges
        )
        if cycle:
            return DependencyCycle(operation_ids=cycle)

        # -- Every check has passed. Nothing above wrote anything; everything below does. --

        job.name = command.name.strip()
        job.priority = command.priority

        if removed_ids:
            await db.execute(delete(Operation).where(Operation.id.in_(removed_ids)))

        ordered_operations: list[Operation] = []
        for index, operation_command in enumerate(command.operations):
            position = index + 1
            if operation_command.id is not None:
                operation = existing_by_id[operation_command.id]
                operation.name = operation_command.name.strip()
                operation.position = position
            else:
                operation = Operation(
                    id=new_ids_by_index[index],
                    job_id=job_id,
                    name=operation_command.name.strip(),
                    position=position,
                )
                db.add(operation)
            ordered_operations.append(operation)
        await db.flush()

        operation_ids = [operation.id for operation in ordered_operations]
        if operation_ids:
            await db.execute(
                delete(Compatibility).where(Compatibility.operation_id.in_(operation_ids))
            )
        for operation, operation_command in zip(
            ordered_operations, command.operations, strict=True
        ):
            for route in operation_command.routes:
                db.add(JobDefinitionService._new_compatibility(operation.id, route))

        if to_delete_ids:
            await db.execute(delete(Dependency).where(Dependency.id.in_(to_delete_ids)))
        db.add_all(
            Dependency(
                before_operation_id=before, after_operation_id=after, origin="builder_sequence"
            )
            for before, after in new_sequence_edges
        )

        await db.flush()
        return DefinitionReplaced(
            definition=await JobDefinitionService._load_definition(db, job_id)
        )

    # -- internals ---------------------------------------------------------

    @staticmethod
    def _new_compatibility(operation_id: UUID, route: BuilderRoute) -> Compatibility:
        return Compatibility(
            operation_id=operation_id,
            machine_id=route.machine_id,
            duration=route.duration_minutes,
            energy=route.energy,
        )

    @staticmethod
    def _sequence_edges(operations: Sequence[Operation]) -> list[Dependency]:
        """Derive a straight chain of ordering edges from consecutive positions.

        Deleted and recreated on every save, per the `builder_sequence` origin's own contract
        (see `dependency.py`) -- never diffed against what was there before.
        """

        return [
            Dependency(
                before_operation_id=before.id,
                after_operation_id=after.id,
                origin="builder_sequence",
            )
            for before, after in pairwise(operations)
        ]

    @staticmethod
    async def _find_external_dependent(
        db: AsyncSession, job_id: UUID, removed_ids: set[UUID]
    ) -> OperationHasExternalDependents | None:
        """Refuse to remove an operation another job's own edge still names.

        `dependencies.before_operation_id`/`after_operation_id` are `ON DELETE CASCADE`, and a
        dependency's `before` side may cross jobs by design (#125) -- deleting the operation this
        job is dropping would otherwise silently take that edge away from a job that never asked
        for the change. An edge fully inside this job is not reported: it belongs to this save,
        whether `external` or `builder_sequence`, and losing it alongside the operation it names is
        exactly what removing that operation means.
        """

        row = (
            await db.execute(
                select(Dependency.before_operation_id, Operation.job_id)
                .join(Operation, Operation.id == Dependency.after_operation_id)
                .where(Dependency.before_operation_id.in_(removed_ids), Operation.job_id != job_id)
                .limit(1)
            )
        ).first()
        if row is None:
            return None

        operation_id, other_job_id = row
        return OperationHasExternalDependents(operation_id=operation_id, job_id=other_job_id)

    @staticmethod
    async def _validate_machines(
        db: AsyncSession, machine_ids: set[UUID]
    ) -> UnknownMachine | InactiveMachine | None:
        """Check every referenced machine exists and is active, in one query.

        Reports the lowest id among the affected machines so the error is deterministic rather than
        depending on set iteration order.
        """

        if not machine_ids:
            return None

        machines = (await db.scalars(select(Machine).where(Machine.id.in_(machine_ids)))).all()
        found_by_id = {machine.id: machine for machine in machines}

        missing = machine_ids - found_by_id.keys()
        if missing:
            return UnknownMachine(machine_id=min(missing))

        inactive = [machine.id for machine in machines if not machine.active]
        if inactive:
            return InactiveMachine(machine_id=min(inactive))

        return None

    @staticmethod
    async def _load_definition(db: AsyncSession, job_id: UUID) -> JobDefinitionRead:
        """Read one job's operations and their routes with two bounded bulk queries.

        Never an ORM lazy load: `Operation.job`/`Compatibility.operation`/`Compatibility.machine`
        exist for ORM identity, not for traversal in async request-handling code.
        """

        job = await db.get(Job, job_id)
        assert job is not None, "caller must have already confirmed the job exists"

        operations_by_job = await JobDefinitionService._load_operations_by_job(db, [job_id])
        return JobDefinitionRead(job=job, operations=operations_by_job.get(job_id, ()))

    @staticmethod
    async def _load_operations_by_job(
        db: AsyncSession, job_ids: Sequence[UUID]
    ) -> dict[UUID, tuple[OperationWithRoutes, ...]]:
        """Read every operation and route for a set of jobs, in two bulk queries total."""

        operations = (
            await db.scalars(
                select(Operation)
                .where(Operation.job_id.in_(job_ids))
                .order_by(Operation.job_id, Operation.position)
            )
        ).all()
        operation_ids = [operation.id for operation in operations]

        routes_by_operation: dict[UUID, list[Compatibility]] = {}
        if operation_ids:
            compatibilities = (
                await db.scalars(
                    select(Compatibility)
                    .where(Compatibility.operation_id.in_(operation_ids))
                    .order_by(Compatibility.operation_id, Compatibility.machine_id)
                )
            ).all()
            for compatibility in compatibilities:
                routes_by_operation.setdefault(compatibility.operation_id, []).append(compatibility)

        by_job: dict[UUID, list[OperationWithRoutes]] = {}
        for operation in operations:
            by_job.setdefault(operation.job_id, []).append(
                OperationWithRoutes(
                    operation=operation,
                    routes=tuple(routes_by_operation.get(operation.id, [])),
                )
            )
        return {job_id: tuple(items) for job_id, items in by_job.items()}
