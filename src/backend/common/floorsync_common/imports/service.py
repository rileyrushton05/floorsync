"""Write an import plan into the floor's own tables, all of it or none of it (decision 0020).

Pasindu's brief: another company's data is imported into our setup tables, not kept apart. So a
plan becomes ordinary rows in `jobs`, `operations`, `compatibilities` and `dependencies`, the same
rows the job builder writes, and every imported job is a new open job in the backlog.

Machines and categories are the exception, because a file and the floor can share them: they are
matched by exact name, reused when the floor has them, and never modified by an import. The floor's
values win; a file that disagrees gets a warning, not an overwrite.

The caller owns the transaction (docs/backend-conventions.md) and must roll it back unless the
result is `ImportApplied`, and for a dry run.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import ColumnElement, SQLColumnExpression, Text, any_, func, insert, literal, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import insert as upsert
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.category import Category
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.imports.checks import (
    check_plan,
    operation_order,
    plan_warnings,
    precedence_edges,
)
from floorsync_common.imports.plan import ImportIssue, ImportPlan, PlannedMachine, PlannedRoute
from floorsync_common.imports.results import (
    ImportApplied,
    ImportPlanResult,
    ImportRejected,
    ImportSummary,
)


@dataclass(frozen=True, slots=True)
class _FloorMachine:
    """A machine the floor already has, as much of it as an import needs to judge."""

    id: UUID
    active: bool
    salary: Decimal | None
    category: str | None


class ImportService:
    """Stateless import of a checked file into the floor's tables."""

    @staticmethod
    async def import_plan(db: AsyncSession, plan: ImportPlan) -> ImportPlanResult:
        """Check `plan` against itself and the floor, then write every row it describes.

        Every problem is collected before anything is written, so a rejection lists them all.
        Machines a route names must be declared in the file or already on the floor, and active.
        New machines and categories are inserted with `ON CONFLICT DO NOTHING`: when two imports
        create the same machine at once, the second waits for the first and reuses its machine
        rather than failing on the unique name.
        """

        issues = list(check_plan(plan))
        warnings = list(plan_warnings(plan))

        # The first declaration of a name wins; a repeat is already a `duplicate_machine` issue.
        declared: dict[str, PlannedMachine] = {}
        for machine in plan.machines:
            declared.setdefault(machine.name, machine)
        routes = [
            route for job in plan.jobs for operation in job.operations for route in operation.routes
        ]
        needed = list(dict.fromkeys([*declared, *(route.machine for route in routes)]))

        floor = await _load_machines(db, needed)
        issues.extend(_route_machine_issues(routes, declared, floor))
        warnings.extend(_floor_differences(declared, floor))

        to_create = [machine for name, machine in declared.items() if name not in floor]
        warnings.extend(await _similar_names(db, to_create))
        categories = list(
            dict.fromkeys(machine.category for machine in to_create if machine.category)
        )
        known_categories = await _load_category_ids(db, categories)

        summary = ImportSummary(
            format=plan.format,
            machines_created=tuple(machine.name for machine in to_create),
            machines_reused=tuple(name for name in needed if name in floor),
            categories_created=tuple(name for name in categories if name not in known_categories),
            jobs=len(plan.jobs),
            operations=plan.operation_count,
            routes=plan.route_count,
            dependencies=sum(len(precedence_edges(job)) for job in plan.jobs),
        )
        if issues:
            return ImportRejected(summary=summary, issues=tuple(issues), warnings=tuple(warnings))

        category_ids, inserted_categories = await _ensure_categories(db, categories)
        machines, inserted_machines = await _ensure_machines(db, to_create, category_ids, needed)
        # What this import actually inserted. Normally what was planned, but a machine another
        # import created a moment earlier was waited for and reused, so it is reported as reused.
        summary = replace(
            summary,
            machines_created=tuple(name for name in needed if name in inserted_machines),
            machines_reused=tuple(name for name in needed if name not in inserted_machines),
            categories_created=tuple(name for name in categories if name in inserted_categories),
        )

        # Seen only now: a machine someone else created, inactive, between the check and the
        # insert, which this import then reused instead of creating.
        late = _route_machine_issues(routes, declared, machines)
        if late:
            return ImportRejected(summary=summary, issues=tuple(late), warnings=tuple(warnings))

        job_ids = await _insert_jobs(
            db, plan, {name: machine.id for name, machine in machines.items()}
        )
        return ImportApplied(summary=summary, job_ids=job_ids, warnings=tuple(warnings))


def _named(column: SQLColumnExpression[str], names: Collection[str]) -> ColumnElement[bool]:
    """`column = ANY(:names)`, one array parameter however many names a file holds.

    An `IN` list binds one parameter per name, and a file can name more machines than PostgreSQL
    accepts parameters in one statement.
    """

    return column == any_(literal(list(names), ARRAY(Text)))


async def _load_machines(db: AsyncSession, names: Collection[str]) -> dict[str, _FloorMachine]:
    if not names:
        return {}
    rows = await db.execute(
        select(Machine.id, Machine.name, Machine.active, Machine.salary, Category.name)
        .outerjoin(Category, Category.id == Machine.category_id)
        .where(_named(Machine.name, names))
    )
    return {
        name: _FloorMachine(id=machine_id, active=active, salary=salary, category=category)
        for machine_id, name, active, salary, category in rows.tuples()
    }


async def _load_category_ids(db: AsyncSession, names: Collection[str]) -> dict[str, UUID]:
    if not names:
        return {}
    rows = await db.execute(select(Category.name, Category.id).where(_named(Category.name, names)))
    return dict(rows.tuples().all())


def _route_machine_issues(
    routes: Sequence[PlannedRoute],
    declared: Mapping[str, PlannedMachine],
    floor: Mapping[str, _FloorMachine],
) -> list[ImportIssue]:
    """One issue per machine a route cannot use, at the first route that names it."""

    uses: dict[str, list[PlannedRoute]] = {}
    for route in routes:
        uses.setdefault(route.machine, []).append(route)

    issues: list[ImportIssue] = []
    for name, named_by in uses.items():
        machine = floor.get(name)
        count = "1 route names it" if len(named_by) == 1 else f"{len(named_by)} routes name it"
        if machine is None and name not in declared:
            issues.append(
                ImportIssue(
                    "unknown_machine",
                    f"Machine {name!r} is not declared in the file and the floor has no machine "
                    f"by that name ({count}).",
                    named_by[0].location,
                )
            )
        elif machine is not None and not machine.active:
            issues.append(
                ImportIssue(
                    "inactive_machine",
                    f"Machine {name!r} is inactive on the floor, so no operation can be routed to "
                    f"it. Reactivate it first ({count}).",
                    named_by[0].location,
                )
            )
    return issues


def _floor_differences(
    declared: Mapping[str, PlannedMachine], floor: Mapping[str, _FloorMachine]
) -> list[ImportIssue]:
    """A warning for each reused machine the file describes differently. The floor's values win."""

    warnings: list[ImportIssue] = []
    for name, planned in declared.items():
        machine = floor.get(name)
        if machine is None:
            continue
        differences: list[str] = []
        if planned.category is not None and planned.category != machine.category:
            differences.append(
                f"category {machine.category!r} (the file says {planned.category!r})"
            )
        if planned.salary is not None and planned.salary != machine.salary:
            floor_salary = "none" if machine.salary is None else str(machine.salary)
            differences.append(f"salary {floor_salary} (the file says {planned.salary})")
        if differences:
            warnings.append(
                ImportIssue(
                    "machine_differs",
                    f"Machine {name!r} is already on the floor with {' and '.join(differences)}. "
                    "An import never changes an existing machine, so the floor's values are kept.",
                    planned.location,
                )
            )
    return warnings


async def _similar_names(
    db: AsyncSession, to_create: Sequence[PlannedMachine]
) -> list[ImportIssue]:
    """A warning for a new machine whose name matches one on the floor except for capitalisation.

    Names match exactly, so `saw 1` would become a second machine beside `Saw 1`. Probably a typo,
    but possibly not, so it is said rather than refused.
    """

    by_lower = {machine.name.lower(): machine for machine in to_create}
    if not by_lower:
        return []
    rows = await db.scalars(select(Machine.name).where(_named(func.lower(Machine.name), by_lower)))
    warnings: list[ImportIssue] = []
    for existing in rows:
        planned = by_lower.get(existing.lower())
        if planned is not None and planned.name != existing:
            warnings.append(
                ImportIssue(
                    "similar_machine_name",
                    f"Machine {planned.name!r} will be created, but the floor already has "
                    f"{existing!r}, which differs only in capitalisation.",
                    planned.location,
                )
            )
    return warnings


async def _ensure_categories(
    db: AsyncSession, names: Sequence[str]
) -> tuple[dict[str, UUID], set[str]]:
    """Every named category's id, and the names this call inserted rather than found."""

    if not names:
        return {}, set()
    # Sorted, so two imports creating overlapping names take their row locks in the same order.
    inserted = await db.scalars(
        upsert(Category)
        .on_conflict_do_nothing(index_elements=[Category.name])
        .returning(Category.name),
        [{"id": uuid4(), "name": name} for name in sorted(names)],
    )
    created = set(inserted)
    return await _load_category_ids(db, names), created


async def _ensure_machines(
    db: AsyncSession,
    to_create: Sequence[PlannedMachine],
    category_ids: Mapping[str, UUID],
    needed: Collection[str],
) -> tuple[dict[str, _FloorMachine], set[str]]:
    """Every needed machine as the floor now has it, and the names this call inserted."""

    created: set[str] = set()
    if to_create:
        inserted = await db.scalars(
            upsert(Machine)
            .on_conflict_do_nothing(index_elements=[Machine.name])
            .returning(Machine.name),
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
        created = set(inserted)
    machines = await _load_machines(db, needed)
    missing = set(needed) - machines.keys()
    if missing:
        # Inserted or already present a moment ago, and machines are never deleted mid-import.
        raise RuntimeError(f"Imported machines vanished before they could be used: {missing}")
    return machines, created


async def _insert_jobs(
    db: AsyncSession, plan: ImportPlan, machine_ids: Mapping[str, UUID]
) -> tuple[UUID, ...]:
    """Insert every job with its operations, routes and precedence, in bulk.

    A job that states no precedence is chained in list order as `builder_sequence` edges, exactly
    what the job builder derives from positions, so the builder can edit it like one of its own.
    Stated precedence is `external`, which the builder leaves alone.
    """

    job_ids: list[UUID] = []
    jobs: list[dict[str, Any]] = []
    operations: list[dict[str, Any]] = []
    routes: list[dict[str, Any]] = []
    dependencies: list[dict[str, Any]] = []

    for job in plan.jobs:
        job_id = uuid4()
        job_ids.append(job_id)
        jobs.append({"id": job_id, "name": job.name, "priority": job.priority})

        order = operation_order(job)
        if order is None:
            raise ValueError(f"Job {job.name!r} has a precedence cycle; check_plan refuses one.")
        position_of = {index: position for position, index in enumerate(order, start=1)}
        operation_ids = [uuid4() for _ in job.operations]

        for index, operation in enumerate(job.operations):
            operations.append(
                {
                    "id": operation_ids[index],
                    "job_id": job_id,
                    "name": operation.name,
                    "position": position_of[index],
                }
            )
            routes.extend(
                {
                    "id": uuid4(),
                    "operation_id": operation_ids[index],
                    "machine_id": machine_ids[route.machine],
                    "duration": route.duration,
                    "energy": route.energy,
                }
                for route in operation.routes
            )

        origin = "external" if job.states_precedence else "builder_sequence"
        dependencies.extend(
            {
                "id": uuid4(),
                "before_operation_id": operation_ids[before],
                "after_operation_id": operation_ids[after],
                "origin": origin,
            }
            for before, after in precedence_edges(job)
        )

    await _insert_all(db, Job, jobs)
    await _insert_all(db, Operation, operations)
    await _insert_all(db, Compatibility, routes)
    await _insert_all(db, Dependency, dependencies)
    return tuple(job_ids)


async def _insert_all(db: AsyncSession, model: type[Any], rows: Iterable[dict[str, Any]]) -> None:
    batch = list(rows)
    if batch:
        await db.execute(insert(model), batch)
