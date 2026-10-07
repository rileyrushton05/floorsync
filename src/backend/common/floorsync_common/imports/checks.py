"""Everything wrong with a plan that the file alone can show, whatever format it came in.

Sizes (a file asking for more than one import may add), values (a duration of zero, an energy
figure the database column cannot hold), then each job's precedence. Problems with machines that
need the floor to judge, such as one that does not exist, are the service's.

An operation may only wait on operations listed before it. That makes a cycle impossible, and it
lets an operation's position be its place in the list: the job builder chains a job's operations
by position whenever it saves, so positions must never contradict the stated precedence.

Nothing here touches the database.
"""

from __future__ import annotations

from decimal import Decimal
from itertools import pairwise

from floorsync_common.imports.plan import ImportIssue, ImportIssueCode, ImportPlan, PlannedJob
from floorsync_common.operations.graph import branching_operations

# The request size limit bounds what a file lists, but not what a classic benchmark declares: a few
# bytes can say `"machines": 3000000`. These bound every format, far above any real floor (the
# largest committed benchmark has 792 jobs, 48 machines and 9,748 routes).
MAX_IMPORT_MACHINES = 1_000
MAX_IMPORT_JOBS = 10_000
MAX_IMPORT_ROWS = 100_000
"""Machines, jobs, operations and routes together."""

MAX_DURATION_MINUTES = 2**31 - 1
"""The largest value `compatibilities.duration`, a PostgreSQL `integer`, can hold."""

MAX_AMOUNT = Decimal("99999999.99")
"""The largest value `machines.salary` and `compatibilities.energy`, `numeric(10, 2)`, can hold."""


def check_size(
    *, machines: int, jobs: int, rows: int, machines_at: str, jobs_at: str
) -> tuple[ImportIssue, ...]:
    """Refuse a file that asks for more than one import may add. Takes counts, not a plan, so a
    benchmark's declared counts can be checked before anything is built from them."""

    issues: list[ImportIssue] = []
    if machines > MAX_IMPORT_MACHINES:
        issues.append(
            ImportIssue(
                ImportIssueCode.TOO_LARGE,
                f"The file describes {machines:,} machines; one import can add at most "
                f"{MAX_IMPORT_MACHINES:,}.",
                machines_at,
            )
        )
    if jobs > MAX_IMPORT_JOBS:
        issues.append(
            ImportIssue(
                ImportIssueCode.TOO_LARGE,
                f"The file describes {jobs:,} jobs; one import can add at most "
                f"{MAX_IMPORT_JOBS:,}.",
                jobs_at,
            )
        )
    if not issues and rows > MAX_IMPORT_ROWS:
        issues.append(
            ImportIssue(
                ImportIssueCode.TOO_LARGE,
                f"The file describes {rows:,} machines, jobs, operations and routes; one import "
                f"can add at most {MAX_IMPORT_ROWS:,}.",
            )
        )
    return tuple(issues)


def check_plan(plan: ImportPlan) -> tuple[ImportIssue, ...]:
    """Every problem with the plan's own values and precedence, all at once."""

    issues: list[ImportIssue] = []

    machine_names: set[str] = set()
    for machine in plan.machines:
        if machine.name in machine_names:
            issues.append(
                ImportIssue(
                    ImportIssueCode.DUPLICATE_MACHINE,
                    f"Machine {machine.name!r} is declared more than once.",
                    machine.location,
                )
            )
        machine_names.add(machine.name)
        if machine.salary is not None:
            issues.extend(_check_amount(machine.salary, f"{machine.location}.salary", "Salary"))

    for job in plan.jobs:
        for operation in job.operations:
            route_machines: set[str] = set()
            for route in operation.routes:
                if route.machine in route_machines:
                    issues.append(
                        ImportIssue(
                            ImportIssueCode.DUPLICATE_ROUTE,
                            f"Machine {route.machine!r} is listed twice for this operation; an "
                            "operation has one duration and energy figure per machine.",
                            route.location,
                        )
                    )
                route_machines.add(route.machine)
                if not 1 <= route.duration <= MAX_DURATION_MINUTES:
                    issues.append(
                        ImportIssue(
                            ImportIssueCode.INVALID_VALUE,
                            "Duration must be a whole number of minutes from 1 to "
                            f"{MAX_DURATION_MINUTES:,}.",
                            f"{route.location}.duration",
                        )
                    )
                if route.energy is not None:
                    issues.extend(_check_amount(route.energy, f"{route.location}.energy", "Energy"))
        issues.extend(_check_precedence(job))

    return tuple(issues)


def plan_warnings(plan: ImportPlan) -> tuple[ImportIssue, ...]:
    """What the file alone says is worth knowing but does not stop the import."""

    return tuple(
        ImportIssue(
            ImportIssueCode.RESCHED_UNSUPPORTED,
            f"Job {job.name!r} has an operation that waits on, or is waited on by, more than one "
            "other. ReSched cannot schedule it; the exact solver can.",
            job.location,
        )
        for job in plan.jobs
        if branching_operations(precedence_edges(job))
    )


def precedence_edges(job: PlannedJob) -> list[tuple[int, int]]:
    """A job's precedence as `(before, after)` pairs of indices into `job.operations`.

    A job that states no precedence runs its operations in the order listed: a straight chain,
    exactly what the job builder would derive from those positions. Otherwise only what is stated.
    A name that does not match an earlier operation is left out; `check_plan` reports it.
    """

    if not job.states_precedence:
        return list(pairwise(range(len(job.operations))))

    index_of = {operation.name: index for index, operation in enumerate(job.operations)}
    edges: list[tuple[int, int]] = []
    for index, operation in enumerate(job.operations):
        for name in dict.fromkeys(operation.after or ()):
            before = index_of.get(name)
            if before is not None and before < index:
                edges.append((before, index))
    return edges


def _check_amount(value: Decimal, location: str, label: str) -> list[ImportIssue]:
    # Bounds first: quantizing a number with a huge exponent would itself fail.
    if value < 0 or value > MAX_AMOUNT:
        return [
            ImportIssue(
                ImportIssueCode.INVALID_VALUE, f"{label} must be from 0 to {MAX_AMOUNT}.", location
            )
        ]
    if value != value.quantize(Decimal("0.01")):
        return [
            ImportIssue(
                ImportIssueCode.INVALID_VALUE,
                f"{label} can have at most two decimal places; it is stored to the cent.",
                location,
            )
        ]
    return []


def _check_precedence(job: PlannedJob) -> list[ImportIssue]:
    if not job.states_precedence:
        return []

    issues: list[ImportIssue] = []
    index_of: dict[str, int] = {}
    for index, operation in enumerate(job.operations):
        if operation.name in index_of:
            issues.append(
                ImportIssue(
                    ImportIssueCode.DUPLICATE_OPERATION_NAME,
                    f"Operation {operation.name!r} appears twice in job {job.name!r}, so an "
                    "'after' naming it would be ambiguous. Operation names must be unique within "
                    "a job that states its precedence.",
                    operation.location,
                )
            )
        index_of.setdefault(operation.name, index)
    if issues:
        return issues

    for index, operation in enumerate(job.operations):
        stated: set[str] = set()
        for position, name in enumerate(operation.after or ()):
            location = f"{operation.location}.after[{position}]"
            before = index_of.get(name)
            if before is None:
                issues.append(
                    ImportIssue(
                        ImportIssueCode.UNKNOWN_PREDECESSOR,
                        f"No operation in job {job.name!r} is called {name!r}.",
                        location,
                    )
                )
            elif name in stated:
                issues.append(
                    ImportIssue(
                        ImportIssueCode.DUPLICATE_DEPENDENCY, f"{name!r} is listed twice.", location
                    )
                )
            elif before == index:
                issues.append(
                    ImportIssue(
                        ImportIssueCode.PREDECESSOR_NOT_EARLIER,
                        f"Operation {name!r} cannot wait for itself.",
                        location,
                    )
                )
            elif before > index:
                issues.append(
                    ImportIssue(
                        ImportIssueCode.PREDECESSOR_NOT_EARLIER,
                        f"Operation {operation.name!r} waits for {name!r}, which is listed after "
                        "it. List operations in an order they can run in.",
                        location,
                    )
                )
            stated.add(name)
    return issues
