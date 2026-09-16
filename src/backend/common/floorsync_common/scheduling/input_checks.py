"""Pure checks on a `SchedulingInput`, shared by every engine and the validation endpoint (#133).

Two different questions get asked of a scheduling input. *Is the data coherent* is a property of
the floor: an operation nothing can run, a route with a zero duration, a cycle in the precedence
graph. *Can this strategy take it* is a property of the engine: ReSched wants linear chains, and
neither engine models machine downtime. Both live here, apart, as functions of the snapshot alone.

This module sits at the bottom of the scheduling package on purpose. It imports only the contracts
and the pure graph helper, never a session, a model or a service, so an engine adapter can depend
on it without dragging the persistence layer in, and the DB-facing `ValidationService` can depend
on it the normal way round. Engine limits are reported per strategy as *unsupported*, never as
invalid: fan-in is legitimate data that one of our two strategies handles (#216).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping
from typing import Literal
from uuid import UUID

from floorsync_common.operations.graph import find_dependency_cycle
from floorsync_common.scheduling.contracts import (
    SchedulingInput,
    SchedulingInputInvalid,
    SchedulingIssue,
)

type StrategyName = Literal["resched", "exact"]
"""The strategies `POST /api/v1/schedules` accepts; the request schema's literal mirrors this."""

STRATEGIES: tuple[StrategyName, ...] = ("resched", "exact")
"""Every strategy, in the order the report lists them."""


def validate_input(problem: SchedulingInput) -> tuple[SchedulingIssue, ...]:
    """Report everything wrong with the data itself, regardless of which engine will run it.

    Every problem is reported, not just the first: a manager fixing a floor wants the whole list.
    Each issue names the record at fault where there is one; a cycle names every operation caught
    in it, via `find_dependency_cycle`, rather than saying only that one exists.
    """

    issues: list[SchedulingIssue] = []
    if problem.starts_at.tzinfo is None:
        issues.append(
            SchedulingIssue("invalid_start", "Schedule start time must include a timezone.")
        )

    machine_ids = {machine.id for machine in problem.machines}
    operation_ids = {operation.id for operation in problem.operations}
    if len(machine_ids) != len(problem.machines):
        issues.append(SchedulingIssue("duplicate_machine", "Machine IDs must be unique."))
    if len(operation_ids) != len(problem.operations):
        issues.append(SchedulingIssue("duplicate_operation", "Operation IDs must be unique."))
    if not operation_ids:
        issues.append(SchedulingIssue("no_operations", "At least one operation is required."))

    active_machine_ids = {machine.id for machine in problem.machines if machine.active}
    route_pairs: set[tuple[UUID, UUID]] = set()
    active_routes: dict[UUID, int] = defaultdict(int)
    for route in problem.routes:
        if route.operation_id not in operation_ids or route.machine_id not in machine_ids:
            issues.append(
                SchedulingIssue(
                    "unknown_route_reference",
                    "A route must reference an included operation and machine.",
                    route.operation_id,
                    route.machine_id,
                )
            )
        if route.duration_minutes <= 0:
            issues.append(
                SchedulingIssue(
                    "invalid_duration",
                    "Route duration must be greater than zero.",
                    route.operation_id,
                    route.machine_id,
                )
            )
        if route.energy is not None and route.energy < 0:
            issues.append(
                SchedulingIssue(
                    "invalid_energy",
                    "Route energy cannot be negative.",
                    route.operation_id,
                    route.machine_id,
                )
            )
        pair = (route.operation_id, route.machine_id)
        if pair in route_pairs:
            issues.append(
                SchedulingIssue(
                    "duplicate_route",
                    "Each operation-machine route must be unique.",
                    route.operation_id,
                    route.machine_id,
                )
            )
        route_pairs.add(pair)
        if route.machine_id in active_machine_ids:
            active_routes[route.operation_id] += 1
    for operation_id in sorted(operation_ids, key=str):
        if active_routes[operation_id] == 0:
            issues.append(
                SchedulingIssue(
                    "no_compatible_machine",
                    "Operation has no active compatible machine.",
                    operation_id,
                )
            )

    dependency_pairs: set[tuple[UUID, UUID]] = set()
    edges: list[tuple[UUID, UUID]] = []
    for edge in problem.dependencies:
        pair = (edge.before_operation_id, edge.after_operation_id)
        if pair in dependency_pairs:
            issues.append(
                SchedulingIssue(
                    "duplicate_dependency",
                    "Dependency edges must be unique.",
                    edge.after_operation_id,
                )
            )
            continue
        dependency_pairs.add(pair)
        if pair[0] not in operation_ids or pair[1] not in operation_ids:
            issues.append(
                SchedulingIssue(
                    "unknown_dependency_operation",
                    "A dependency must reference included operations.",
                    edge.after_operation_id,
                )
            )
        elif pair[0] == pair[1]:
            issues.append(
                SchedulingIssue(
                    "self_dependency",
                    "An operation cannot depend on itself.",
                    edge.after_operation_id,
                )
            )
        else:
            edges.append(pair)

    for operation_id in find_dependency_cycle(edges):
        issues.append(
            SchedulingIssue(
                "cyclic_dependencies",
                "This operation is part of a dependency cycle and can never be scheduled.",
                operation_id,
            )
        )

    return tuple(issues)


def resched_strategy_limits(problem: SchedulingInput) -> tuple[SchedulingIssue, ...]:
    """What the pretrained ReSched policy cannot take, on data that is otherwise coherent.

    Limits of this strategy, not faults in the floor: the exact solver takes a general precedence
    DAG, and neither engine models downtime. Each fan-in or fan-out offender is named.
    """

    issues: list[SchedulingIssue] = []
    if problem.unavailabilities:
        issues.append(
            SchedulingIssue(
                "unsupported_unavailability",
                "ReSched does not model machine downtime.",
            )
        )

    predecessors: dict[UUID, int] = defaultdict(int)
    successors: dict[UUID, int] = defaultdict(int)
    for edge in problem.dependencies:
        predecessors[edge.after_operation_id] += 1
        successors[edge.before_operation_id] += 1
    shape_offenders = sorted(
        {operation_id for operation_id, count in predecessors.items() if count > 1}
        | {operation_id for operation_id, count in successors.items() if count > 1},
        key=str,
    )
    issues.extend(
        SchedulingIssue(
            "unsupported_dependency_shape",
            "ReSched requires at most one predecessor and successor per operation.",
            operation_id,
        )
        for operation_id in shape_offenders
    )
    return tuple(issues)


def exact_strategy_limits(problem: SchedulingInput) -> tuple[SchedulingIssue, ...]:
    """What the exact solver cannot take: only machine downtime, which its model leaves out."""

    if problem.unavailabilities:
        return (
            SchedulingIssue(
                "unsupported_unavailability",
                "The exact solver does not model machine downtime.",
            ),
        )
    return ()


_LIMITS = {"resched": resched_strategy_limits, "exact": exact_strategy_limits}


def strategy_limits(
    problem: SchedulingInput,
) -> Mapping[StrategyName, tuple[SchedulingIssue, ...]]:
    """Per strategy, what a coherent input still could not be scheduled with."""

    return {strategy: _LIMITS[strategy](problem) for strategy in STRATEGIES}


def validate_for_strategy(
    problem: SchedulingInput, strategy: StrategyName
) -> SchedulingInputInvalid | None:
    """Everything that stops `strategy` running on this input, as one refusal, or nothing.

    Data problems first, then the strategy's own limits, in one list: this is what a worker runs
    before handing the input to its engine, and it is exactly the set of things the validation
    endpoint reports as `issues` plus that strategy's `unsupported`, so the two can never
    disagree. An engine may re-check its own limits afterwards; that is cheap and keeps the engine
    safe to call on its own.
    """

    issues = validate_input(problem) + _LIMITS[strategy](problem)
    return SchedulingInputInvalid(issues=issues) if issues else None


__all__ = [
    "STRATEGIES",
    "StrategyName",
    "exact_strategy_limits",
    "resched_strategy_limits",
    "strategy_limits",
    "validate_for_strategy",
    "validate_input",
]
