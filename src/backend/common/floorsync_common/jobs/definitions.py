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
from uuid import UUID

from sqlalchemy import Select, delete, exists, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.job import Job, JobPriority
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.schedule_entry import ScheduleEntry
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
    OperationWithRoutes,
    ReplaceDefinitionResult,
    UnknownMachine,
)
from floorsync_common.jobs.results import JobNotFound
from floorsync_common.pagination import decode_cursor, encode_cursor


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
        db: AsyncSession, *, limit: int = 50, cursor: str | None = None
    ) -> DefinitionsListed:
        """Read one page of job definitions ordered by name, with every operation and route.

        Fetches the page's nested data with two further bulk queries regardless of page size, so
        the frontend has no N+1 detail fetch.
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

        Refuses the whole save, writing nothing, when any of the job's current operations already
        appears in a schedule -- that schedule's record of what was planned must not be rewritten.
        Otherwise reconciles operations by id (update retained, add new, delete omitted -- deletion
        safely cascades that operation's own routes and ordering edges since the job is
        unscheduled), replaces every retained/new operation's routes outright, and rebuilds only
        this job's `builder_sequence` ordering edges from the new order. Edges with any other
        origin are never touched.
        """

        job = await db.scalar(select(Job).where(Job.id == job_id).with_for_update())
        if job is None:
            return JobNotFound(job_id=job_id)

        existing_operations = (
            await db.scalars(select(Operation).where(Operation.job_id == job_id))
        ).all()
        existing_by_id = {operation.id: operation for operation in existing_operations}

        if existing_by_id and await db.scalar(
            select(exists().where(ScheduleEntry.operation_id.in_(existing_by_id.keys())))
        ):
            return JobDefinitionIsScheduled(job_id=job_id)

        for operation_command in command.operations:
            if operation_command.id is not None and operation_command.id not in existing_by_id:
                return OperationDoesNotBelongToJob(operation_id=operation_command.id, job_id=job_id)

        machine_ids = {
            route.machine_id for operation in command.operations for route in operation.routes
        }
        invalid = await JobDefinitionService._validate_machines(db, machine_ids)
        if invalid is not None:
            return invalid

        job.name = command.name.strip()
        job.priority = command.priority

        retained_ids = {
            operation_command.id
            for operation_command in command.operations
            if operation_command.id is not None
        }
        removed_ids = existing_by_id.keys() - retained_ids
        if removed_ids:
            await db.execute(delete(Operation).where(Operation.id.in_(removed_ids)))

        ordered_operations: list[Operation] = []
        for position, operation_command in enumerate(command.operations, start=1):
            if operation_command.id is not None:
                operation = existing_by_id[operation_command.id]
                operation.name = operation_command.name.strip()
                operation.position = position
            else:
                operation = Operation(
                    job_id=job_id, name=operation_command.name.strip(), position=position
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

        # Every operation this job had before the save, retained or removed -- a removed
        # operation's own edges already cascaded with it, so re-targeting this delete at it is a
        # harmless no-op, not a second source of truth for what to clean up.
        owned_before_save = existing_by_id.keys()
        if owned_before_save:
            await db.execute(
                delete(Dependency).where(
                    Dependency.origin == "builder_sequence",
                    or_(
                        Dependency.before_operation_id.in_(owned_before_save),
                        Dependency.after_operation_id.in_(owned_before_save),
                    ),
                )
            )
        db.add_all(JobDefinitionService._sequence_edges(ordered_operations))

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
