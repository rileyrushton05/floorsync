"""A real Gurobi solve, catching a wrong `build_model` constraint that mocks cannot.

Every other test around the exact solver mocks `solve_fajsp` itself (see `test_schedule_worker.py`)
or the database read (the deleted `test_load_fajsp_from_db.py`), so none of them would catch a
mistake inside `build_model`'s constraints. This test solves a small, hand-checkable instance for
real and asserts against an optimum worked out by hand -- a fan-in shape, the kind ReSchedEngine
cannot accept (#216) but this solver is meant to handle.

Hand-worked optimum: A (dur 3, only M1) and B (dur 3, only M2) can both start at 0. C (dur 2, either
machine) waits on A, so starts at 3 at the earliest and ends at 5 regardless of which machine it
picks. D (dur 3, only M1) fans in from both B (ends 3) and C (ends 5), so it cannot start before 5,
and ends at 8. No machine contention forces it later than that, so 8 is optimal.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from uuid import UUID, uuid4

from floorsync_common.scheduling.contracts import (
    DependencySpec,
    MachineSpec,
    OperationSpec,
    RouteSpec,
    ScheduledOperation,
    SchedulingInput,
)
from floorsync_common.scheduling.gurobi_exact_solver import adapt_scheduling_input, solve_fajsp


def test_solve_fajsp_finds_the_provable_optimum_for_a_fan_in_instance() -> None:
    machine_1, machine_2 = uuid4(), uuid4()
    op_a, op_b, op_c, op_d = uuid4(), uuid4(), uuid4(), uuid4()
    starts_at = datetime(2026, 9, 6, 8, tzinfo=UTC)

    problem = SchedulingInput(
        starts_at=starts_at,
        machines=(
            MachineSpec(id=machine_1, active=True, salary_per_minute=Decimal("1.00")),
            MachineSpec(id=machine_2, active=True, salary_per_minute=Decimal("2.00")),
        ),
        operations=(
            OperationSpec(id=op_a, name="a"),
            OperationSpec(id=op_b, name="b"),
            OperationSpec(id=op_c, name="c"),
            OperationSpec(id=op_d, name="d"),
        ),
        routes=(
            RouteSpec(operation_id=op_a, machine_id=machine_1, duration_minutes=3, energy=None),
            RouteSpec(operation_id=op_b, machine_id=machine_2, duration_minutes=3, energy=None),
            RouteSpec(operation_id=op_c, machine_id=machine_1, duration_minutes=2, energy=None),
            RouteSpec(operation_id=op_c, machine_id=machine_2, duration_minutes=2, energy=None),
            RouteSpec(operation_id=op_d, machine_id=machine_1, duration_minutes=3, energy=None),
        ),
        dependencies=(
            DependencySpec(before_operation_id=op_a, after_operation_id=op_c),
            DependencySpec(before_operation_id=op_b, after_operation_id=op_d),
            DependencySpec(before_operation_id=op_c, after_operation_id=op_d),
        ),
    )

    operations, eligible_machines, operation_data, machine_meta = adapt_scheduling_input(problem)
    plan, _runtime_ms, proven_optimal, gap = solve_fajsp(
        operations, eligible_machines, operation_data, machine_meta, starts_at
    )

    assert proven_optimal
    assert gap == 0.0
    assert plan.metrics.makespan_minutes == 8

    # Every operation is assigned exactly once, only to a machine it has a route on (#137, #63),
    # and its end time is its start time plus that route's duration (#64).
    durations = {
        (route.operation_id, route.machine_id): route.duration_minutes for route in problem.routes
    }
    assert sorted(a.operation_id for a in plan.assignments) == sorted(
        o.id for o in problem.operations
    )
    for assignment in plan.assignments:
        assert (assignment.operation_id, assignment.machine_id) in durations
        assert (
            assignment.duration_minutes == durations[assignment.operation_id, assignment.machine_id]
        )
        assert assignment.ends_at == assignment.starts_at + timedelta(
            minutes=assignment.duration_minutes
        )

    ends_at = {assignment.operation_id: assignment.ends_at for assignment in plan.assignments}
    starts_at_by_op = {
        assignment.operation_id: assignment.starts_at for assignment in plan.assignments
    }
    for dependency in problem.dependencies:
        assert (
            starts_at_by_op[dependency.after_operation_id]
            >= ends_at[dependency.before_operation_id]
        )

    by_machine: dict[UUID, list[ScheduledOperation]] = {}
    for assignment in plan.assignments:
        by_machine.setdefault(assignment.machine_id, []).append(assignment)
    for assignments in by_machine.values():
        ordered = sorted(assignments, key=lambda assignment: assignment.starts_at)
        for previous, current in pairwise(ordered):
            assert previous.ends_at <= current.starts_at


def test_solve_fajsp_records_a_machine_queue_edge_for_unrelated_operations() -> None:
    """Two operations with no precedence between them still need an ordering reason.

    Both can only run on the single machine available, so Gurobi must sequence them one after the
    other; whichever order it picks, `build_schedule_plan` must record why with a `machine_queue`
    edge, the same as `ReSchedEngine._to_plan` does for its own output.
    """
    machine = uuid4()
    op_x, op_y = uuid4(), uuid4()
    starts_at = datetime(2026, 9, 6, 8, tzinfo=UTC)

    problem = SchedulingInput(
        starts_at=starts_at,
        machines=(MachineSpec(id=machine, active=True, salary_per_minute=None),),
        operations=(OperationSpec(id=op_x, name="x"), OperationSpec(id=op_y, name="y")),
        routes=(
            RouteSpec(operation_id=op_x, machine_id=machine, duration_minutes=4, energy=None),
            RouteSpec(operation_id=op_y, machine_id=machine, duration_minutes=5, energy=None),
        ),
        dependencies=(),
    )

    operations, eligible_machines, operation_data, machine_meta = adapt_scheduling_input(problem)
    plan, _runtime_ms, proven_optimal, _gap = solve_fajsp(
        operations, eligible_machines, operation_data, machine_meta, starts_at
    )

    assert proven_optimal
    assert plan.metrics.makespan_minutes == 9

    queue_edges = [
        dependency for dependency in plan.dependencies if dependency.reason == "machine_queue"
    ]
    assert len(queue_edges) == 1
    assert {queue_edges[0].schedule_operation_id, queue_edges[0].depends_on_operation_id} == {
        op_x,
        op_y,
    }
