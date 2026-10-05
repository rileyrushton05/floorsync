"""Everything wrong with a plan that the file alone can show, whatever format it came in.

Values first (a duration of zero, an energy figure the database column cannot hold), then each
job's precedence (a name that matches no operation, a cycle). Problems with machines that need
the floor to judge, such as one that does not exist, are the service's.

Also here, because the writer and the checks must agree on them exactly: the order a job's
operations are numbered in, and the precedence edges a job stands for.

Nothing here touches the database.
"""

from __future__ import annotations

import heapq
from collections.abc import Sequence
from decimal import Decimal
from itertools import pairwise

from floorsync_common.imports.plan import (
    ImportIssue,
    ImportPlan,
    PlannedJob,
    PlannedMachine,
    PlannedRoute,
)
from floorsync_common.operations.graph import branching_operations

MAX_DURATION_MINUTES = 2_147_483_647
"""`compatibilities.duration` is a PostgreSQL `integer`."""

MAX_AMOUNT = Decimal("99999999.99")
"""`machines.salary` and `compatibilities.energy` are `numeric(10, 2)`."""

CENT = Decimal("0.01")


def check_plan(plan: ImportPlan) -> tuple[ImportIssue, ...]:
    """Every problem with the plan's own values and precedence, all at once."""

    issues: list[ImportIssue] = []
    issues.extend(_check_machines(plan.machines))
    for job in plan.jobs:
        for operation in job.operations:
            issues.extend(_check_routes(operation.routes))
        issues.extend(_check_precedence(job))
    return tuple(issues)


def plan_warnings(plan: ImportPlan) -> tuple[ImportIssue, ...]:
    """What the file alone says is worth knowing but does not stop the import."""

    return tuple(
        ImportIssue(
            "resched_unsupported",
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
    exactly what the job builder would derive from those positions. Otherwise only what is stated,
    and an operation with no `after` waits for nothing. Names that match no operation are dropped
    here; `check_plan` reports them.
    """

    if not job.states_precedence:
        return list(pairwise(range(len(job.operations))))

    index_of = {operation.name: index for index, operation in enumerate(job.operations)}
    edges: list[tuple[int, int]] = []
    for index, operation in enumerate(job.operations):
        for name in dict.fromkeys(operation.after or ()):
            before = index_of.get(name)
            if before is not None and before != index:
                edges.append((before, index))
    return edges


def operation_order(job: PlannedJob) -> tuple[int, ...] | None:
    """Indices of `job.operations` in the order their positions are numbered, or `None` on a cycle.

    A topological order that keeps the file's own order wherever precedence allows it. Positions
    must never contradict precedence: the job builder chains a job's operations by position when it
    saves, so a later edit to an imported job would otherwise create a cycle and be refused.
    """

    order, stuck = _stable_topological_order(len(job.operations), precedence_edges(job))
    return None if stuck else tuple(order)


def _check_machines(machines: Sequence[PlannedMachine]) -> list[ImportIssue]:
    issues: list[ImportIssue] = []
    seen: set[str] = set()
    for machine in machines:
        if machine.name in seen:
            issues.append(
                ImportIssue(
                    "duplicate_machine",
                    f"Machine {machine.name!r} is declared more than once.",
                    machine.location,
                )
            )
        seen.add(machine.name)
        if machine.salary is not None:
            issues.extend(_check_amount(machine.salary, f"{machine.location}.salary", "Salary"))
    return issues


def _check_routes(routes: Sequence[PlannedRoute]) -> list[ImportIssue]:
    issues: list[ImportIssue] = []
    seen: set[str] = set()
    for route in routes:
        if route.machine in seen:
            issues.append(
                ImportIssue(
                    "duplicate_route",
                    f"Machine {route.machine!r} is listed twice for this operation; an operation "
                    "has one duration and energy figure per machine.",
                    route.location,
                )
            )
        seen.add(route.machine)
        if not 1 <= route.duration <= MAX_DURATION_MINUTES:
            issues.append(
                ImportIssue(
                    "invalid_value",
                    f"Duration must be a whole number of minutes from 1 to {MAX_DURATION_MINUTES}.",
                    f"{route.location}.duration",
                )
            )
        if route.energy is not None:
            issues.extend(_check_amount(route.energy, f"{route.location}.energy", "Energy"))
    return issues


def _check_amount(value: Decimal, location: str, label: str) -> list[ImportIssue]:
    # Bounds first: quantizing a number with a huge exponent would itself fail.
    if value < 0 or value > MAX_AMOUNT:
        return [ImportIssue("invalid_value", f"{label} must be from 0 to {MAX_AMOUNT}.", location)]
    if value != value.quantize(CENT):
        return [
            ImportIssue(
                "invalid_value",
                f"{label} can have at most two decimal places; it is stored to the cent.",
                location,
            )
        ]
    return []


def _check_precedence(job: PlannedJob) -> list[ImportIssue]:
    if not job.states_precedence:
        return []

    issues: list[ImportIssue] = []
    seen: set[str] = set()
    for operation in job.operations:
        if operation.name in seen:
            issues.append(
                ImportIssue(
                    "duplicate_operation_name",
                    f"Operation {operation.name!r} appears twice in job {job.name!r}, so an "
                    "'after' naming it would be ambiguous. Operation names must be unique within "
                    "a job that states its precedence.",
                    operation.location,
                )
            )
        seen.add(operation.name)
    if issues:
        return issues

    for operation in job.operations:
        stated: set[str] = set()
        for index, name in enumerate(operation.after or ()):
            location = f"{operation.location}.after[{index}]"
            if name == operation.name:
                issues.append(
                    ImportIssue(
                        "self_dependency",
                        f"Operation {name!r} cannot wait for itself.",
                        location,
                    )
                )
            elif name not in seen:
                issues.append(
                    ImportIssue(
                        "unknown_predecessor",
                        f"No operation in job {job.name!r} is called {name!r}.",
                        location,
                    )
                )
            elif name in stated:
                issues.append(
                    ImportIssue(
                        "duplicate_dependency",
                        f"{name!r} is listed twice.",
                        location,
                    )
                )
            stated.add(name)

    _, stuck = _stable_topological_order(len(job.operations), precedence_edges(job))
    if stuck:
        names = ", ".join(repr(job.operations[index].name) for index in sorted(stuck))
        issues.append(
            ImportIssue(
                "dependency_cycle",
                f"Operations {names} are caught in, or wait on, a precedence cycle, so none of "
                "them could ever start.",
                job.location,
            )
        )
    return issues


def _stable_topological_order(
    count: int, edges: Sequence[tuple[int, int]]
) -> tuple[list[int], set[int]]:
    """Kahn's algorithm, always taking the earliest-listed ready node.

    Returns the order and the nodes left over, which are exactly those caught in a cycle (or
    waiting on one).
    """

    successors: list[list[int]] = [[] for _ in range(count)]
    incoming = [0] * count
    for before, after in edges:
        successors[before].append(after)
        incoming[after] += 1

    ready = [node for node in range(count) if incoming[node] == 0]
    heapq.heapify(ready)
    order: list[int] = []
    while ready:
        node = heapq.heappop(ready)
        order.append(node)
        for following in successors[node]:
            incoming[following] -= 1
            if incoming[following] == 0:
                heapq.heappush(ready, following)

    return order, {node for node in range(count) if incoming[node] > 0}
