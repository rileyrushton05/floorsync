"""Pre-scheduling validation (#133): the shared data checks, the per-strategy limits, and the
service that reads the floor for them."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.scheduling.contracts import (
    DependencySpec,
    MachineSpec,
    OperationSpec,
    RouteSpec,
    SchedulingInput,
    SchedulingInputInvalid,
    SchedulingIssue,
    UnavailabilitySpec,
)
from floorsync_common.scheduling.resched import ReSchedEngine
from floorsync_common.scheduling.validation import (
    JOB_HAS_NO_OPERATIONS,
    MACHINE_HAS_NO_CAPABILITIES,
    ValidationService,
    strategy_limits,
    validate_for_worker,
    validate_input,
)

STARTS_AT = datetime(2026, 9, 17, 8, tzinfo=UTC)


def _floor(
    *,
    operations: int = 2,
    machines: int = 1,
    active: bool = True,
    dependencies: tuple[tuple[int, int], ...] = ((0, 1),),
    routes: Callable[[list[UUID], list[UUID]], tuple[RouteSpec, ...]] | None = None,
    unavailabilities: tuple[UnavailabilitySpec, ...] = (),
) -> tuple[SchedulingInput, list[UUID], list[UUID]]:
    operation_ids = [uuid4() for _ in range(operations)]
    machine_ids = [uuid4() for _ in range(machines)]
    if routes is None:
        route_specs = tuple(
            RouteSpec(operation_id=op, machine_id=machine_ids[0], duration_minutes=5, energy=None)
            for op in operation_ids
        )
    else:
        route_specs = routes(operation_ids, machine_ids)
    return (
        SchedulingInput(
            starts_at=STARTS_AT,
            machines=tuple(
                MachineSpec(id=machine, active=active, salary_per_minute=None)
                for machine in machine_ids
            ),
            operations=tuple(
                OperationSpec(id=op, name=f"op{i}") for i, op in enumerate(operation_ids)
            ),
            routes=route_specs,
            dependencies=tuple(
                DependencySpec(
                    before_operation_id=operation_ids[before],
                    after_operation_id=operation_ids[after],
                )
                for before, after in dependencies
            ),
            unavailabilities=unavailabilities,
        ),
        operation_ids,
        machine_ids,
    )


def _codes(issues: tuple[SchedulingIssue, ...]) -> set[str]:
    return {issue.code for issue in issues}


# -- validate_input ---------------------------------------------------------------------------


def test_a_coherent_floor_has_no_issues() -> None:
    problem, _, _ = _floor()

    assert validate_input(problem) == ()
    assert validate_for_worker(problem) is None


def test_an_empty_floor_is_refused() -> None:
    problem, _, _ = _floor(operations=0, dependencies=())

    assert _codes(validate_input(problem)) == {"no_operations"}


def test_an_operation_with_only_inactive_machines_is_named() -> None:
    problem, operation_ids, _ = _floor(active=False)

    issues = validate_input(problem)

    assert _codes(issues) == {"no_compatible_machine"}
    assert {issue.operation_id for issue in issues} == set(operation_ids)


def test_route_problems_name_the_operation_and_machine() -> None:
    def routes(operation_ids: list[UUID], machine_ids: list[UUID]) -> tuple[RouteSpec, ...]:
        machine = machine_ids[0]
        return (
            RouteSpec(
                operation_id=operation_ids[0], machine_id=machine, duration_minutes=0, energy=None
            ),
            RouteSpec(
                operation_id=operation_ids[1],
                machine_id=machine,
                duration_minutes=5,
                energy=Decimal("-1"),
            ),
            RouteSpec(
                operation_id=operation_ids[1], machine_id=machine, duration_minutes=5, energy=None
            ),
        )

    problem, operation_ids, machine_ids = _floor(routes=routes)

    issues = validate_input(problem)

    by_code = {issue.code: issue for issue in issues}
    assert set(by_code) == {"invalid_duration", "invalid_energy", "duplicate_route"}
    assert by_code["invalid_duration"].operation_id == operation_ids[0]
    assert by_code["invalid_duration"].machine_id == machine_ids[0]
    assert by_code["duplicate_route"].operation_id == operation_ids[1]


def test_a_cycle_names_every_operation_caught_in_it() -> None:
    problem, operation_ids, _ = _floor(operations=3, dependencies=((0, 1), (1, 2), (2, 0)))

    issues = validate_input(problem)

    assert _codes(issues) == {"cyclic_dependencies"}
    assert {issue.operation_id for issue in issues} == set(operation_ids)


def test_dependency_edge_problems_are_reported_individually() -> None:
    problem, operation_ids, _ = _floor(operations=2, dependencies=((0, 1), (0, 1), (1, 1)))
    stranger = uuid4()
    problem = SchedulingInput(
        starts_at=problem.starts_at,
        machines=problem.machines,
        operations=problem.operations,
        routes=problem.routes,
        dependencies=(
            *problem.dependencies,
            DependencySpec(before_operation_id=stranger, after_operation_id=operation_ids[0]),
        ),
    )

    issues = validate_input(problem)

    assert _codes(issues) == {
        "duplicate_dependency",
        "self_dependency",
        "unknown_dependency_operation",
    }


def test_every_problem_is_reported_at_once_not_just_the_first() -> None:
    """A manager fixing a floor wants the whole list."""

    problem, _, _ = _floor(operations=3, active=False, dependencies=((0, 1), (1, 0)))

    issues = validate_input(problem)

    assert _codes(issues) == {"no_compatible_machine", "cyclic_dependencies"}
    assert sum(1 for issue in issues if issue.code == "no_compatible_machine") == 3


def test_a_naive_start_time_is_refused() -> None:
    problem, _, _ = _floor()
    problem = SchedulingInput(
        starts_at=datetime(2026, 9, 17, 8),
        machines=problem.machines,
        operations=problem.operations,
        routes=problem.routes,
        dependencies=problem.dependencies,
    )

    assert _codes(validate_input(problem)) == {"invalid_start"}


# -- strategy limits --------------------------------------------------------------------------


def test_fan_in_is_unsupported_by_resched_but_valid_data() -> None:
    """Fan-in is the shape #216 is about: the exact solver takes it, ReSched does not."""

    problem, operation_ids, _ = _floor(operations=3, dependencies=((0, 2), (1, 2)))

    assert validate_input(problem) == ()
    limits = strategy_limits(problem)
    assert _codes(limits["resched"]) == {"unsupported_dependency_shape"}
    assert {issue.operation_id for issue in limits["resched"]} == {operation_ids[2]}
    assert limits["exact"] == ()


def test_fan_out_names_the_operation_with_two_successors() -> None:
    problem, operation_ids, _ = _floor(operations=3, dependencies=((0, 1), (0, 2)))

    issues = ReSchedEngine.unsupported(problem)

    assert _codes(issues) == {"unsupported_dependency_shape"}
    assert {issue.operation_id for issue in issues} == {operation_ids[0]}


def test_machine_downtime_is_unsupported_by_both_strategies() -> None:
    problem, _, _ = _floor(
        unavailabilities=(
            UnavailabilitySpec(machine_id=uuid4(), starts_at=STARTS_AT, ends_at=STARTS_AT),
        ),
    )

    limits = strategy_limits(problem)

    assert _codes(limits["resched"]) == {"unsupported_unavailability"}
    assert _codes(limits["exact"]) == {"unsupported_unavailability"}


def test_resched_validation_still_refuses_incoherent_data_itself() -> None:
    """The engine keeps its own guard, now delegating to the shared checks, so a caller that skips
    the worker's validation still cannot run it on a cycle."""

    problem, operation_ids, _ = _floor(operations=2, dependencies=((0, 1), (1, 0)))

    issues, chains = ReSchedEngine._validate(problem)

    assert _codes(issues) == {"cyclic_dependencies"}
    assert {issue.operation_id for issue in issues} == set(operation_ids)
    assert chains == ()


def test_resched_validation_lays_a_coherent_linear_floor_out_as_chains() -> None:
    problem, operation_ids, _ = _floor(operations=3, dependencies=((0, 1), (1, 2)))

    issues, chains = ReSchedEngine._validate(problem)

    assert issues == ()
    assert chains == (tuple(operation_ids),)


# -- ValidationService ------------------------------------------------------------------------


class FakeScalars:
    def __init__(self, values: list[Any]) -> None:
        self._values = values

    def all(self) -> list[Any]:
        return self._values


class FakeSession:
    """Answer `run_sync` with a canned load result and the two warning reads with canned ids."""

    def __init__(
        self,
        loaded: SchedulingInput | SchedulingInputInvalid,
        *,
        empty_jobs: list[UUID] | None = None,
        idle_machines: list[UUID] | None = None,
    ) -> None:
        self.loaded = loaded
        self.empty_jobs = empty_jobs or []
        self.idle_machines = idle_machines or []

    async def run_sync(self, fn: Callable[[Any], Any]) -> Any:
        return self.loaded

    async def scalars(self, statement: Any) -> FakeScalars:
        rendered = str(statement)
        if "FROM jobs" in rendered:
            return FakeScalars(self.empty_jobs)
        if "FROM machines" in rendered:
            return FakeScalars(self.idle_machines)
        raise AssertionError(f"Unexpected query: {rendered}")


def _run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def _session(fake: FakeSession) -> AsyncSession:
    return cast(AsyncSession, fake)


def test_service_reports_a_coherent_floor_as_schedulable_by_every_strategy() -> None:
    problem, _, _ = _floor()

    report = _run(ValidationService.validate_floor(_session(FakeSession(problem))))

    assert report.issues == ()
    assert report.unsupported == ()
    assert report.schedulable == {"resched": True, "exact": True}


def test_service_reports_fan_in_as_schedulable_by_exact_only() -> None:
    problem, _, _ = _floor(operations=3, dependencies=((0, 2), (1, 2)))

    report = _run(ValidationService.validate_floor(_session(FakeSession(problem))))

    assert report.issues == ()
    assert [limit.strategy for limit in report.unsupported] == ["resched"]
    assert report.schedulable == {"resched": False, "exact": True}


def test_service_turns_a_data_problem_into_no_for_every_strategy() -> None:
    problem, _, _ = _floor(active=False)

    report = _run(ValidationService.validate_floor(_session(FakeSession(problem))))

    assert _codes(report.issues) == {"no_compatible_machine"}
    assert report.schedulable == {"resched": False, "exact": False}


def test_service_reports_a_refused_selection_as_issues() -> None:
    """A manager who ticked an archived job should hear it here, not after queueing a run."""

    job_id = uuid4()
    refused = SchedulingInputInvalid(
        issues=(SchedulingIssue("archived_job", "Archived.", job_id=job_id),)
    )

    report = _run(
        ValidationService.validate_floor(_session(FakeSession(refused)), job_ids=[job_id])
    )

    assert _codes(report.issues) == {"archived_job"}
    assert report.schedulable == {"resched": False, "exact": False}


def test_service_warns_about_empty_jobs_and_idle_machines_by_id() -> None:
    problem, _, _ = _floor()
    job_id, machine_id = uuid4(), uuid4()

    report = _run(
        ValidationService.validate_floor(
            _session(FakeSession(problem, empty_jobs=[job_id], idle_machines=[machine_id]))
        )
    )

    assert [(w.code, w.job_id, w.machine_id) for w in report.warnings] == [
        (JOB_HAS_NO_OPERATIONS, job_id, None),
        (MACHINE_HAS_NO_CAPABILITIES, None, machine_id),
    ]
    assert report.schedulable == {"resched": True, "exact": True}
