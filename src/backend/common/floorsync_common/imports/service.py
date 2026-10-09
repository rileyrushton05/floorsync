"""Read an uploaded file and write it into the floor's own tables, all of it or none of it
(decision 0020).

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

import json
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal, DecimalException
from typing import NoReturn, TypedDict, assert_never
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
from floorsync_common.imports.benchmarks import read_flexible_jobshop, read_jobshop
from floorsync_common.imports.checks import (
    check_plan,
    check_size,
    check_text,
    plan_warnings,
    precedence_edges,
)
from floorsync_common.imports.floorsync_file import FLOORSYNC_VERSION, read_floorsync_file
from floorsync_common.imports.plan import (
    ImportFormat,
    ImportIssue,
    ImportIssueCode,
    ImportPlan,
    PlannedMachine,
    PlannedRoute,
)
from floorsync_common.imports.results import (
    FileUnreadable,
    ImportApplied,
    ImportPlanResult,
    ImportRejected,
    ImportSummary,
    PlanRead,
    ReadFileResult,
)
from floorsync_common.seed.flexible import is_flexible_payload


@dataclass(frozen=True, slots=True)
class _FloorMachine:
    """A machine the floor already has, as much of it as an import needs to judge."""

    id: UUID
    active: bool
    salary: Decimal | None
    category: str | None


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


class ImportService:
    """Read an uploaded file, then import its checked plan into the floor's tables."""

    @staticmethod
    def read_file(raw: bytes) -> ReadFileResult:
        """Turn an uploaded file into a plan, or say why it cannot be.

        The format is told apart by content, not by filename. Pure: it never touches the database,
        so the caller runs it before opening a transaction.
        """

        if not raw.strip():
            return _unreadable(ImportIssueCode.EMPTY_FILE, "The file is empty.")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return _unreadable(ImportIssueCode.NOT_UTF8, "The file is not UTF-8 text.")

        try:
            document = json.loads(
                text,
                # Exact decimals for energy and salary, never binary floats (api-conventions.md).
                parse_float=Decimal,
                parse_constant=_reject_non_finite,
                object_pairs_hook=_object_without_duplicate_keys,
            )
        except _DuplicateKey as error:
            return _unreadable(
                ImportIssueCode.DUPLICATE_KEY,
                f"The key {error.key!r} appears twice in one object, so it is unclear which value "
                "was meant.",
            )
        except json.JSONDecodeError as error:
            return _unreadable(
                ImportIssueCode.NOT_JSON,
                f"The file is not valid JSON: {error.msg} (line {error.lineno}, column "
                f"{error.colno}).",
            )
        except DecimalException:
            # `parse_float=Decimal` on a number like 1e999999999999999999999.
            return _unreadable(
                ImportIssueCode.NOT_JSON, "The file contains a number too large to read."
            )
        except ValueError as error:
            # NaN or Infinity, or Python's own limits, such as an integer thousands of digits long.
            return _unreadable(ImportIssueCode.NOT_JSON, f"The file is not valid JSON: {error}.")
        except RecursionError:
            return _unreadable(
                ImportIssueCode.TOO_DEEPLY_NESTED, "The file nests too deeply to read."
            )

        if not isinstance(document, dict):
            return _unreadable(
                ImportIssueCode.NOT_AN_OBJECT,
                "The file must contain one JSON object, not a list or a value.",
            )

        if document.get("format") == ImportFormat.FLOORSYNC:
            read = read_floorsync_file(document)
            machines_at, jobs_at = "machines", "jobs"
        elif is_flexible_payload(document):
            read = read_flexible_jobshop(document)
            machines_at, jobs_at = "operations", "precedences"
        elif "data" in document:
            # Also checks its declared counts itself, before building anything from them.
            read = read_jobshop(document)
            machines_at, jobs_at = "machines", "jobs"
        else:
            return _unreadable(
                ImportIssueCode.UNKNOWN_FORMAT,
                "The file is not a format FloorSync imports. A FloorSync file starts with "
                f'"format": "{ImportFormat.FLOORSYNC}" and "version": {FLOORSYNC_VERSION}; a '
                "benchmark file is a ScheduleOpt job-shop or flexible job-shop instance.",
            )

        # Every format ends here, so these hold for any plan this returns.
        match read:
            case PlanRead(plan=plan):
                issues = check_size(
                    machines=len(plan.machines),
                    jobs=len(plan.jobs),
                    rows=len(plan.machines)
                    + len(plan.jobs)
                    + plan.operation_count
                    + plan.route_count,
                    machines_at=machines_at,
                    jobs_at=jobs_at,
                ) or check_text(plan)
                return FileUnreadable(issues=issues) if issues else read
            case FileUnreadable():
                return read
            case _:
                assert_never(read)

    @staticmethod
    async def import_plan(db: AsyncSession, plan: ImportPlan) -> ImportPlanResult:
        """Check `plan` against itself and the floor, then write every row it describes.

        Every problem is collected before anything is written, so a rejection lists them all.
        Machines a route names must be declared in the file or already on the floor, and active.
        """

        issues = list(check_plan(plan))
        file_warnings = plan_warnings(plan)

        # The first declaration of a name wins; a repeat is already a `duplicate_machine` issue.
        declared: dict[str, PlannedMachine] = {}
        for machine in plan.machines:
            declared.setdefault(machine.name, machine)
        routes = [
            route for job in plan.jobs for operation in job.operations for route in operation.routes
        ]
        needed = list(dict.fromkeys([*declared, *(route.machine for route in routes)]))

        floor = await ImportService._load_machines(db, needed)
        issues.extend(_route_machine_issues(routes, declared, floor))

        to_create = [machine for name, machine in declared.items() if name not in floor]
        similar = await ImportService._similar_names(db, to_create)
        categories = list(
            dict.fromkeys(machine.category for machine in to_create if machine.category)
        )
        known_categories = await ImportService._load_category_ids(db, categories)

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
            warnings = (*file_warnings, *_floor_differences(declared, floor), *similar)
            return ImportRejected(summary=summary, issues=tuple(issues), warnings=warnings)

        (
            machines,
            created_machines,
            created_categories,
        ) = await ImportService._create_missing_machines(db, to_create, needed)
        # What this import actually inserted. Normally what was planned, but a machine another
        # import created a moment earlier was waited for and reused, so it is reported as reused.
        summary = replace(
            summary,
            machines_created=tuple(name for name in needed if name in created_machines),
            machines_reused=tuple(name for name in needed if name not in created_machines),
            categories_created=tuple(name for name in categories if name in created_categories),
        )
        # Judged against the machines as they are now: one another import created after the first
        # lookup is reused with its values, not the file's, and the file must be told.
        warnings = (*file_warnings, *_floor_differences(declared, machines), *similar)

        # Seen only now: a machine someone else created, inactive, between the check and the
        # insert, which this import then reused instead of creating.
        late = _route_machine_issues(routes, declared, machines)
        if late:
            return ImportRejected(summary=summary, issues=tuple(late), warnings=warnings)

        job_ids = await ImportService._insert_jobs(
            db, plan, {name: machine.id for name, machine in machines.items()}
        )
        return ImportApplied(summary=summary, job_ids=job_ids, warnings=warnings)

    @staticmethod
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

    @staticmethod
    async def _load_category_ids(db: AsyncSession, names: Collection[str]) -> dict[str, UUID]:
        if not names:
            return {}
        rows = await db.execute(
            select(Category.name, Category.id).where(_named(Category.name, names))
        )
        return dict(rows.tuples().all())

    @staticmethod
    async def _similar_names(
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
    async def _create_missing_machines(
        db: AsyncSession, to_create: Sequence[PlannedMachine], needed: Collection[str]
    ) -> tuple[dict[str, _FloorMachine], set[str], set[str]]:
        """Insert the new machines and their categories, safe against a concurrent import.

        Returns every needed machine as the floor now has it, and the machine and category names
        this call actually inserted. Rows are inserted with `ON CONFLICT DO NOTHING`, sorted by
        name so two imports take their row locks in the same order: when two imports create the
        same machine at once, the second waits for the first and reuses its machine rather than
        failing on the unique name.
        """

        if not to_create:
            return await ImportService._load_machines(db, needed), set(), set()

        category_names = sorted({machine.category for machine in to_create if machine.category})
        created_categories: set[str] = set()
        if category_names:
            inserted = await db.scalars(
                upsert(Category)
                .on_conflict_do_nothing(index_elements=[Category.name])
                .returning(Category.name),
                [{"id": uuid4(), "name": name} for name in category_names],
            )
            created_categories = set(inserted)
        category_ids = await ImportService._load_category_ids(db, category_names)

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
        created_machines = set(inserted)

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

        machines = await ImportService._load_machines(db, needed)
        missing = set(needed) - machines.keys()
        if missing:
            # Inserted or already present a moment ago, and machines are never deleted mid-import.
            raise RuntimeError(f"Imported machines vanished before they could be used: {missing}")
        return machines, created_machines, created_categories

    @staticmethod
    async def _insert_jobs(
        db: AsyncSession, plan: ImportPlan, machine_ids: Mapping[str, UUID]
    ) -> tuple[UUID, ...]:
        """Insert every job with its operations, routes and precedence; return the new job ids.

        An operation's position is its place in the file, which `check_plan` guarantees never
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
                for before, after in precedence_edges(job)
            )

        # Every plan has at least one job, operation and route; a job may have no precedence.
        await db.execute(insert(Job), jobs)
        await db.execute(insert(Operation), operations)
        await db.execute(insert(Compatibility), routes)
        if dependencies:
            await db.execute(insert(Dependency), dependencies)
        return tuple(job["id"] for job in jobs)


def _unreadable(code: ImportIssueCode, message: str) -> FileUnreadable:
    return FileUnreadable(issues=(ImportIssue(code, message),))


class _DuplicateKey(Exception):
    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key


def _object_without_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    document: dict[str, object] = {}
    for key, value in pairs:
        if key in document:
            raise _DuplicateKey(key)
        document[key] = value
    return document


def _reject_non_finite(constant: str) -> NoReturn:
    raise ValueError(f"{constant} is not a JSON number")


def _named(column: SQLColumnExpression[str], names: Collection[str]) -> ColumnElement[bool]:
    """`column = ANY(:names)`, one array parameter however many names a file holds.

    An `IN` list binds one parameter per name, and a file can name more machines than PostgreSQL
    accepts parameters in one statement.
    """

    return column == any_(literal(list(names), ARRAY(Text)))


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
                    ImportIssueCode.UNKNOWN_MACHINE,
                    f"Machine {name!r} is not declared in the file and the floor has no machine "
                    f"by that name ({count}).",
                    named_by[0].location,
                )
            )
        elif machine is not None and not machine.active:
            issues.append(
                ImportIssue(
                    ImportIssueCode.INACTIVE_MACHINE,
                    f"Machine {name!r} is inactive on the floor, so no operation can be routed to "
                    f"it. Reactivate it first ({count}).",
                    named_by[0].location,
                )
            )
    return issues


def _floor_differences(
    declared: Mapping[str, PlannedMachine], floor: Mapping[str, _FloorMachine]
) -> list[ImportIssue]:
    """A warning for each reused machine the file describes differently. The floor's values win.

    A machine this import created itself matches the file, so it never warns.
    """

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
                    ImportIssueCode.MACHINE_DIFFERS,
                    f"Machine {name!r} is already on the floor with {' and '.join(differences)}. "
                    "An import never changes an existing machine, so the floor's values are kept.",
                    planned.location,
                )
            )
    return warnings
