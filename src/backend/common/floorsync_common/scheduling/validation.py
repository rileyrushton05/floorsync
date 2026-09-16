"""Check production data before any scheduler sees it (#133).

Two different questions get asked of a scheduling input, and they used to be answered in the same
place. *Is the data coherent* is a property of the floor: an operation nothing can run, a route with
a zero duration, a cycle in the precedence graph. *Can this strategy take it* is a property of the
engine: ReSched wants linear chains, neither engine models machine downtime. The first kind lived
inside `ReSchedEngine._validate`, which meant it only ran during generation, reported a cycle
without naming the operations, and was reimplemented separately for the exact solver.

This module owns the first kind, once, for every caller: both worker tasks run it before their
engine, and `ValidationService` runs it on demand so a manager can see what is wrong before asking
for a schedule. The second kind stays with each engine and is reported here per strategy as
*unsupported*, never as invalid, because fan-in is legitimate data that one of our two strategies
handles (#216).

Pure functions take a `SchedulingInput`; the service is the only thing that knows the database.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.operations.service import find_dependency_cycle
from floorsync_common.scheduling.contracts import (
    SchedulingInput,
    SchedulingInputInvalid,
    SchedulingIssue,
)
from floorsync_common.scheduling.resched import ReSchedEngine
from floorsync_common.scheduling.service import LoadInputResult, SchedulingService

JOB_HAS_NO_OPERATIONS = "job_has_no_operations"
"""An open job holds no operation, so a whole-floor run silently leaves it unplanned."""

MACHINE_HAS_NO_CAPABILITIES = "machine_has_no_capabilities"
"""An active machine no operation can run on, so no schedule will ever use it."""

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


def exact_strategy_limits(problem: SchedulingInput) -> tuple[SchedulingIssue, ...]:
    """What the exact solver cannot take: only machine downtime, which its model does not include.

    Lives here rather than in the solver module because that module imports `gurobipy` at load
    time, and the validation service must answer without it.
    """

    if problem.unavailabilities:
        return (
            SchedulingIssue(
                "unsupported_unavailability",
                "The exact solver does not model machine downtime.",
            ),
        )
    return ()


def strategy_limits(
    problem: SchedulingInput,
) -> Mapping[StrategyName, tuple[SchedulingIssue, ...]]:
    """Per strategy, what a coherent input still could not be scheduled with."""

    return {
        "resched": ReSchedEngine.unsupported(problem),
        "exact": exact_strategy_limits(problem),
    }


@dataclass(frozen=True, slots=True)
class StrategyLimit:
    """One thing a named strategy cannot take, on otherwise coherent data."""

    strategy: StrategyName
    issue: SchedulingIssue


@dataclass(frozen=True, slots=True)
class FloorValidation:
    """Everything a manager should know before asking for a schedule.

    `issues` are data problems that stop every strategy. `warnings` are things worth knowing that
    stop nothing. `unsupported` lists, per strategy, what coherent data that strategy still cannot
    take. `schedulable` answers the question the scheduler page asks: could I press Generate with
    this strategy right now?
    """

    issues: tuple[SchedulingIssue, ...]
    warnings: tuple[SchedulingIssue, ...]
    unsupported: tuple[StrategyLimit, ...]
    schedulable: Mapping[StrategyName, bool]


class ValidationService:
    """Read the floor as generation would and report what is wrong with it. Stateless."""

    @staticmethod
    async def validate_floor(
        db: AsyncSession, *, job_ids: Collection[UUID] | None = None
    ) -> FloorValidation:
        """Validate the whole floor, or the given selection, without generating anything.

        Loads through `SchedulingService.load_input` so the snapshot is exactly what a generation
        run would see, selection refusals included: those come back as issues too, since a manager
        who ticked an unknown or archived job wants to hear it here rather than after queueing a
        run. `starts_at` is now, because nothing here depends on the start beyond it having a
        timezone.
        """

        selection = None if job_ids is None else frozenset(job_ids)

        def load(session: Session) -> LoadInputResult:
            return SchedulingService.load_input(
                session, starts_at=datetime.now(UTC), job_ids=selection
            )

        loaded = await db.run_sync(load)
        warnings = await ValidationService._warnings(db, selection)

        match loaded:
            case SchedulingInputInvalid(issues=issues):
                return FloorValidation(
                    issues=issues,
                    warnings=warnings,
                    unsupported=(),
                    schedulable={strategy: False for strategy in STRATEGIES},
                )
            case SchedulingInput() as problem:
                pass

        issues = validate_input(problem)
        limits = strategy_limits(problem)
        unsupported = tuple(
            StrategyLimit(strategy=strategy, issue=issue)
            for strategy in STRATEGIES
            for issue in limits[strategy]
        )
        return FloorValidation(
            issues=issues,
            warnings=warnings,
            unsupported=unsupported,
            schedulable={strategy: not issues and not limits[strategy] for strategy in STRATEGIES},
        )

    @staticmethod
    async def _warnings(
        db: AsyncSession, selection: frozenset[UUID] | None
    ) -> tuple[SchedulingIssue, ...]:
        """The two facts the snapshot cannot show, because the rows in question leave no trace.

        A job with no operations contributes nothing to the input, so a whole-floor run plans
        around it without a word; an active machine nothing can run on is never chosen. Neither
        blocks a schedule, both are probably mistakes.
        """

        empty_jobs = (
            select(Job.id)
            .outerjoin(Operation, Operation.job_id == Job.id)
            .where(Operation.id.is_(None), Job.archived_at.is_(None))
            .order_by(Job.id)
        )
        if selection is not None:
            empty_jobs = empty_jobs.where(Job.id.in_(selection))
        idle_machines = (
            select(Machine.id)
            .outerjoin(Compatibility, Compatibility.machine_id == Machine.id)
            .where(Compatibility.id.is_(None), Machine.active.is_(True))
            .order_by(Machine.id)
        )

        warnings = [
            SchedulingIssue(
                JOB_HAS_NO_OPERATIONS,
                "This job has no operations, so a schedule would not include it.",
                job_id=job_id,
            )
            for job_id in (await db.scalars(empty_jobs)).all()
        ]
        warnings.extend(
            SchedulingIssue(
                MACHINE_HAS_NO_CAPABILITIES,
                "No operation can run on this machine, so no schedule will use it.",
                machine_id=machine_id,
            )
            for machine_id in (await db.scalars(idle_machines)).all()
        )
        return tuple(warnings)


def validate_for_worker(problem: SchedulingInput) -> SchedulingInputInvalid | None:
    """The worker-side shape of `validate_input`: a refusal to return, or nothing to refuse."""

    issues = validate_input(problem)
    return SchedulingInputInvalid(issues=issues) if issues else None


__all__ = [
    "JOB_HAS_NO_OPERATIONS",
    "MACHINE_HAS_NO_CAPABILITIES",
    "STRATEGIES",
    "FloorValidation",
    "StrategyLimit",
    "StrategyName",
    "ValidationService",
    "exact_strategy_limits",
    "strategy_limits",
    "validate_for_worker",
    "validate_input",
]
