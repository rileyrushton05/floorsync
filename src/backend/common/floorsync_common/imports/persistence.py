"""Every database read and write an import makes, in the caller's transaction.

Machines and categories are matched by exact name, reused when the floor has them and never
modified; new ones are inserted so that concurrent imports share them. Jobs, operations, routes
and dependencies are written in bulk. Nothing here commits or rolls back.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from decimal import Decimal
from typing import TypedDict
from uuid import UUID, uuid4

from sqlalchemy import (
    ColumnElement,
    SQLColumnExpression,
    Text,
    any_,
    delete,
    exists,
    func,
    insert,
    literal,
    select,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import insert as upsert
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.category import Category
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency, DependencyOrigin
from floorsync_common.database.models.job import Job, JobPriority
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.imports.plan import (
    FloorMachine,
    ImportIssue,
    ImportIssueCode,
    ImportPlan,
    PlannedMachine,
)
from floorsync_common.imports.validation import ImportValidationService
from floorsync_common.users.operators import OperatorService
from floorsync_common.users.service import UserService


class _JobRow(TypedDict):
    id: UUID
    name: str
    priority: JobPriority


class _OperationRow(TypedDict):
    id: UUID
    job_id: UUID
    name: str
    position: int


class _RouteRow(TypedDict):
    id: UUID
    operation_id: UUID
    machine_id: UUID
    duration: int
    energy: Decimal | None


class _DependencyRow(TypedDict):
    id: UUID
    before_operation_id: UUID
    after_operation_id: UUID
    origin: DependencyOrigin


class ImportPersistenceService:
    """Reads the floor's machines and writes an import's rows."""

    @staticmethod
    async def load_machines(
        db: AsyncSession, names: Collection[str], *, lock: bool = False
    ) -> dict[str, FloorMachine]:
        """The named machines the floor has. With `lock`, held until the caller's transaction ends.

        A locked machine cannot be changed or deleted by anyone else until then, so what was read
        stays true while routes are written to it. Locked in name order, the order every import
        takes them in, so two imports wait for each other rather than deadlock.
        """

        if not names:
            return {}
        statement = (
            select(Machine.id, Machine.name, Machine.active, Machine.salary, Category.name)
            .outerjoin(Category, Category.id == Machine.category_id)
            .where(_named(Machine.name, names))
        )
        if lock:
            # Only the machine rows: a category may be shared by machines this import does not use.
            statement = statement.order_by(Machine.name).with_for_update(of=Machine)
        rows = await db.execute(statement)
        return {
            name: FloorMachine(id=machine_id, active=active, salary=salary, category=category)
            for machine_id, name, active, salary, category in rows.tuples()
        }

    @staticmethod
    async def load_category_ids(db: AsyncSession, names: Collection[str]) -> dict[str, UUID]:
        if not names:
            return {}
        rows = await db.execute(
            select(Category.name, Category.id).where(_named(Category.name, names))
        )
        return dict(rows.tuples().all())

    @staticmethod
    async def similar_names(
        db: AsyncSession, to_create: Sequence[PlannedMachine]
    ) -> list[ImportIssue]:
        """A warning for a new machine whose name matches one on the floor except for case.

        Names match exactly, so `saw 1` would become a second machine beside `Saw 1`. Probably a
        typo, but possibly not, so it is said rather than refused.
        """

        by_lower = {machine.name.lower(): machine for machine in to_create}
        if not by_lower:
            return []
        existing_names = await db.scalars(
            select(Machine.name).where(_named(func.lower(Machine.name), by_lower))
        )
        warnings: list[ImportIssue] = []
        for existing in existing_names:
            planned = by_lower.get(existing.lower())
            if planned is not None and planned.name != existing:
                warnings.append(
                    ImportIssue(
                        ImportIssueCode.SIMILAR_MACHINE_NAME,
                        f"Machine {planned.name!r} will be created, but the floor already has "
                        f"{existing!r}, which differs only in capitalisation.",
                        planned.location,
                    )
                )
        return warnings

    @staticmethod
    async def create_missing_machines(
        db: AsyncSession,
        to_create: Sequence[PlannedMachine],
        needed: Collection[str],
        *,
        operator_password: str,
    ) -> tuple[dict[str, FloorMachine], set[str], set[str]]:
        """Insert the new machines, their categories and their operator logins, safe against a
        concurrent import.

        Every machine has its own operator login (#312), so each machine this call inserts gets
        one, starting with `operator_password`. A machine another import created first is reused
        and keeps the login it was created with.

        Returns every needed machine the floor now has, locked until the transaction ends (one
        deleted meanwhile is simply absent), and the machine and category names this call
        actually inserted. Rows are inserted with `ON CONFLICT DO NOTHING`, sorted by
        name so two imports take their row locks in the same order: when two imports create the
        same machine at once, the second waits for the first and reuses its machine rather than
        failing on the unique name.
        """

        if not to_create:
            return await ImportPersistenceService.load_machines(db, needed, lock=True), set(), set()

        category_names = sorted({machine.category for machine in to_create if machine.category})
        created_categories: set[str] = set()
        if category_names:
            inserted_categories = await db.scalars(
                upsert(Category)
                .on_conflict_do_nothing(index_elements=[Category.name])
                .returning(Category.name),
                [{"id": uuid4(), "name": name} for name in category_names],
            )
            created_categories = set(inserted_categories)
        category_ids = await ImportPersistenceService.load_category_ids(db, category_names)

        inserted_machines = await db.execute(
            upsert(Machine)
            .on_conflict_do_nothing(index_elements=[Machine.name])
            .returning(Machine.id, Machine.name),
            [
                {
                    "id": uuid4(),
                    "name": machine.name,
                    "category_id": category_ids[machine.category] if machine.category else None,
                    "salary": machine.salary,
                }
                for machine in sorted(to_create, key=lambda machine: machine.name)
            ],
        )
        created = sorted((machine_id, name) for machine_id, name in inserted_machines.tuples())
        created_machines = {name for _, name in created}
        if created:
            # Hashed once for the batch: Argon2 is slow on purpose.
            await OperatorService.create_for_machines(
                db, created, password_hash=UserService.hash_password(operator_password)
            )

        # A category inserted for a machine another import created first is left with no machine,
        # since that machine keeps its own category. Only rows this call inserted are removed.
        if created_categories:
            removed = await db.scalars(
                delete(Category)
                .where(
                    _named(Category.name, created_categories),
                    ~exists().where(Machine.category_id == Category.id),
                )
                .returning(Category.name)
            )
            created_categories -= set(removed)

        machines = await ImportPersistenceService.load_machines(db, needed, lock=True)
        return machines, created_machines, created_categories

    @staticmethod
    async def insert_jobs(
        db: AsyncSession, plan: ImportPlan, machine_ids: Mapping[str, UUID]
    ) -> tuple[UUID, ...]:
        """Insert every job with its operations, routes and precedence; return the new job ids.

        An operation's position is its place in the file, which validation guarantees never
        contradicts precedence. A job that states no precedence is chained in list order as
        `builder_sequence` edges, exactly what the job builder derives from positions, so the
        builder can edit it like one of its own. Stated precedence is `external`, which the
        builder leaves alone.
        """

        # Plain rows in four bulk inserts: building ORM objects for a large benchmark is about five
        # times slower (1.3 s against 0.25 s for the 9,748 routes of behnke58).
        jobs: list[_JobRow] = []
        operations: list[_OperationRow] = []
        routes: list[_RouteRow] = []
        dependencies: list[_DependencyRow] = []
        for job in plan.jobs:
            job_id = uuid4()
            jobs.append({"id": job_id, "name": job.name, "priority": job.priority})
            operation_ids = [uuid4() for _ in job.operations]
            for position, (operation_id, operation) in enumerate(
                zip(operation_ids, job.operations, strict=True), start=1
            ):
                operations.append(
                    {
                        "id": operation_id,
                        "job_id": job_id,
                        "name": operation.name,
                        "position": position,
                    }
                )
                routes.extend(
                    {
                        "id": uuid4(),
                        "operation_id": operation_id,
                        "machine_id": machine_ids[route.machine],
                        "duration": route.duration,
                        "energy": route.energy,
                    }
                    for route in operation.routes
                )
            origin: DependencyOrigin = "external" if job.states_precedence else "builder_sequence"
            dependencies.extend(
                {
                    "id": uuid4(),
                    "before_operation_id": operation_ids[before],
                    "after_operation_id": operation_ids[after],
                    "origin": origin,
                }
                for before, after in ImportValidationService.precedence_edges(job)
            )

        # Every plan has at least one job, operation and route; a job may have no precedence.
        await db.execute(insert(Job), jobs)
        await db.execute(insert(Operation), operations)
        await db.execute(insert(Compatibility), routes)
        if dependencies:
            await db.execute(insert(Dependency), dependencies)
        return tuple(job["id"] for job in jobs)


def _named(column: SQLColumnExpression[str], names: Collection[str]) -> ColumnElement[bool]:
    """`column = ANY(:names)`, one array parameter however many names a file holds.

    An `IN` list binds one parameter per name, and a file can name more machines than PostgreSQL
    accepts parameters in one statement.
    """

    return column == any_(literal(list(names), ARRAY(Text)))
