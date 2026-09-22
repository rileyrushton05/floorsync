"""Solve a Flexible Job Shop Scheduling Problem instance with Gurobi.

Builds the disjunctive MILP formulation for a floor snapshot already assembled by
`SchedulingService.load_input`, and solves it for the minimum makespan.
"""

import logging
import time
from collections.abc import Sequence
from datetime import datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import TypedDict
from uuid import UUID

import gurobipy as gp

from floorsync_common.scheduling.contracts import (
    ScheduleDependencySpec,
    ScheduledOperation,
    ScheduleMetrics,
    SchedulePlan,
    SchedulingInput,
)

logger = logging.getLogger(__name__)

TIME_LIMIT_SECONDS = 120
STRATEGY = "gurobi_exact_v1"


class NoFeasibleSchedule(Exception):
    """Gurobi could not certify a feasible assignment for this instance.

    Distinct from `RuntimeError` (and from `gurobipy.GurobiError`, e.g. a missing licence) so a
    caller can tell "this floor cannot be scheduled" from "the engine could not run at all".
    """


class OpRecord(TypedDict):
    """One operation as laid out for the solver, indexed by its position in `op_list`.

    `energy_by_machine` is keyed by the same machine indices as `options`, so a solved
    schedule can be written back to the database with the cost snapshot `ScheduleEntry`
    expects.
    """

    op_id: UUID
    options: list[tuple[int, int]]
    pre: list[int]
    energy_by_machine: dict[int, Decimal | None]


def adapt_scheduling_input(
    problem: SchedulingInput,
) -> tuple[range, dict[int, list[int]], list[OpRecord], list[tuple[UUID, Decimal | None]]]:
    """Translate a `SchedulingInput` snapshot into the solver's index-based arrays.

    `SchedulingService.load_input` never filters inactive machines out of `machines` or `routes`
    (an active machine's own route selection is the adapter's job, per that method's docstring), so
    this function does it here -- the same filtering `exact_solver_queries.load_active_machines`
    and `load_routes` used to do in SQL, kept so the solver sizes the same problem ReSched does, not
    a larger one for Gurobi to explore.

    Machines and operations are ordered by id so the resulting index assignment -- and therefore
    which optimal solution Gurobi returns among ties -- is reproducible across runs of the same
    input, the same way `ReSchedEngine._run` orders its own machine list.

    Raises:
        ValueError: if an operation has no compatible active machine to run on.
    """
    active_machines = sorted(
        (machine for machine in problem.machines if machine.active),
        key=lambda machine: str(machine.id),
    )
    machine_index = {machine.id: index for index, machine in enumerate(active_machines)}
    machine_meta = [(machine.id, machine.salary_per_minute) for machine in active_machines]

    operations_sorted = sorted(problem.operations, key=lambda operation: str(operation.id))
    operation_index = {operation.id: index for index, operation in enumerate(operations_sorted)}

    options_by_op: list[list[tuple[int, int]]] = [[] for _ in operations_sorted]
    energy_by_op: list[dict[int, Decimal | None]] = [{} for _ in operations_sorted]
    for route in problem.routes:
        machine_idx = machine_index.get(route.machine_id)
        if machine_idx is None:
            continue
        op_idx = operation_index[route.operation_id]
        options_by_op[op_idx].append((route.duration_minutes, machine_idx))
        energy_by_op[op_idx][machine_idx] = route.energy

    op_list: list[OpRecord] = []
    for index, operation in enumerate(operations_sorted):
        options = options_by_op[index]
        if not options:
            raise ValueError(f"Operation {operation.id} has no compatible active machine.")
        op_list.append(
            {
                "op_id": operation.id,
                "options": options,
                "pre": [],
                "energy_by_machine": energy_by_op[index],
            }
        )
    for dependency in problem.dependencies:
        op_list[operation_index[dependency.after_operation_id]]["pre"].append(
            operation_index[dependency.before_operation_id]
        )

    operations = range(len(op_list))
    eligible_machines = {i: [k for _, k in op_list[i]["options"]] for i in operations}
    return operations, eligible_machines, op_list, machine_meta


def processing_time(operation_data: Sequence[OpRecord], operation: int, machine: int) -> int | None:
    """Processing time of `operation` on `machine`, or None if ineligible."""
    for duration, candidate_machine in operation_data[operation]["options"]:
        if candidate_machine == machine:
            return duration
    return None


def required_processing_time(
    operation_data: Sequence[OpRecord], operation: int, machine: int
) -> int:
    """Like `processing_time`, but for call sites where `machine` is already known eligible."""
    duration = processing_time(operation_data, operation, machine)
    assert duration is not None
    return duration


def build_model(
    operations: range,
    eligible_machines: dict[int, list[int]],
    operation_data: Sequence[OpRecord],
) -> tuple[gp.Model, dict[tuple[int, int], gp.Var], dict[int, gp.Var], gp.Var]:
    """Build the disjunctive MILP. Returns the model and its variables."""
    horizon = sum(max(duration for duration, _ in record["options"]) for record in operation_data)

    model = gp.Model("fajsp")
    model.Params.TimeLimit = TIME_LIMIT_SECONDS

    # assignment[i, k]: operation i is assigned to machine k
    assignment = {
        (operation, machine): model.addVar(
            vtype=gp.GRB.BINARY, name=f"assign[{operation},{machine}]"
        )
        for operation in operations
        for machine in eligible_machines[operation]
    }

    # start_time[i]: start time of operation i
    start_time = {
        operation: model.addVar(vtype=gp.GRB.INTEGER, name=f"start[{operation}]")
        for operation in operations
    }

    makespan = model.addVar(vtype=gp.GRB.INTEGER, name="makespan")

    def duration_expression(operation: int) -> gp.LinExpr:
        """Processing time of an operation as a linear expression."""
        return gp.quicksum(
            required_processing_time(operation_data, operation, machine)
            * assignment[operation, machine]
            for machine in eligible_machines[operation]
        )

    # (1) minimise the makespan
    model.setObjective(makespan, gp.GRB.MINIMIZE)

    # (2) each operation runs on exactly one eligible machine
    for operation in operations:
        model.addConstr(
            gp.quicksum(assignment[operation, machine] for machine in eligible_machines[operation])
            == 1,
            name=f"assign_once[{operation}]",
        )

    # (3) precedence: an operation starts after each of its predecessors finishes
    for operation in operations:
        for predecessor in operation_data[operation]["pre"]:
            model.addConstr(
                start_time[operation] >= start_time[predecessor] + duration_expression(predecessor),
                name=f"precedence[{predecessor},{operation}]",
            )

    # (4) and (5) two operations sharing a machine cannot overlap. One `sequenced_before`
    # binary per unordered pair sharing a machine: it and the two constraints below jointly
    # encode "either `first` finishes before `second` starts, or vice versa" for that pair,
    # so visiting each unordered pair once is sufficient -- visiting both orderings would
    # duplicate the same disjunction with a second, redundant binary.
    for first in operations:
        for second in operations:
            if second <= first:
                continue
            shared_machines = set(eligible_machines[first]) & set(eligible_machines[second])
            if not shared_machines:
                continue
            sequenced_before = model.addVar(vtype=gp.GRB.BINARY, name=f"before[{first},{second}]")
            for machine in shared_machines:
                slack_a = (
                    2 - assignment[first, machine] - assignment[second, machine] + sequenced_before
                )
                model.addConstr(
                    start_time[first]
                    >= start_time[second]
                    + required_processing_time(operation_data, second, machine)
                    - slack_a * horizon,
                    name=f"no_overlap_a[{first},{second},{machine}]",
                )
                slack_b = (
                    3 - assignment[first, machine] - assignment[second, machine] - sequenced_before
                )
                model.addConstr(
                    start_time[second]
                    >= start_time[first]
                    + required_processing_time(operation_data, first, machine)
                    - slack_b * horizon,
                    name=f"no_overlap_b[{first},{second},{machine}]",
                )

    # (6) the makespan covers every operation
    for operation in operations:
        model.addConstr(
            makespan >= start_time[operation] + duration_expression(operation),
            name=f"makespan[{operation}]",
        )

    return model, assignment, start_time, makespan


def report(
    operation_data: Sequence[OpRecord],
    eligible_machines: dict[int, list[int]],
    assignment: dict[tuple[int, int], gp.Var],
    start_time: dict[int, gp.Var],
    makespan: gp.Var,
    model: gp.Model,
) -> None:
    """Log the solved schedule, and whether its makespan is proven optimal."""
    logger.info(
        "solved fajsp instance",
        extra={
            "makespan_minutes": int(makespan.X),
            "status": model.Status,
            "mip_gap": model.MIPGap,
        },
    )
    for operation, record in enumerate(operation_data):
        machine = next(
            candidate
            for candidate in eligible_machines[operation]
            if assignment[operation, candidate].X > 0.5
        )
        logger.info(
            "scheduled operation",
            extra={
                "operation_id": str(record["op_id"]),
                "machine": machine,
                "start_minutes": int(start_time[operation].X),
            },
        )


def build_schedule_plan(
    operation_data: Sequence[OpRecord],
    eligible_machines: dict[int, list[int]],
    assignment: dict[tuple[int, int], gp.Var],
    start_time: dict[int, gp.Var],
    makespan: gp.Var,
    machine_meta: list[tuple[UUID, Decimal | None]],
    starts_at: datetime,
) -> SchedulePlan:
    """Turn a solved model into a `SchedulePlan`, ready for `SchedulingService.store_draft`."""
    assignments: list[ScheduledOperation] = []
    machine_by_operation: list[int] = []
    for operation, record in enumerate(operation_data):
        machine = next(
            candidate
            for candidate in eligible_machines[operation]
            if assignment[operation, candidate].X > 0.5
        )
        machine_by_operation.append(machine)
        duration = required_processing_time(operation_data, operation, machine)
        machine_id, salary_per_minute = machine_meta[machine]
        op_starts_at = starts_at + timedelta(minutes=int(start_time[operation].X))
        assignments.append(
            ScheduledOperation(
                operation_id=record["op_id"],
                machine_id=machine_id,
                starts_at=op_starts_at,
                ends_at=op_starts_at + timedelta(minutes=duration),
                duration_minutes=duration,
                energy=record["energy_by_machine"].get(machine),
                machine_salary_per_minute=salary_per_minute,
            )
        )

    dependencies = [
        ScheduleDependencySpec(
            schedule_operation_id=operation_data[operation]["op_id"],
            depends_on_operation_id=operation_data[predecessor]["op_id"],
            reason="job_order",
        )
        for operation, record in enumerate(operation_data)
        for predecessor in record["pre"]
    ]

    # A machine queue edge orders two operations Gurobi placed consecutively on the same machine,
    # the same as `ReSchedEngine._to_plan`: without it, two operations sharing a machine but no
    # job-order edge would have no recorded reason the timeline resolver can use to sequence them.
    existing_edges = {
        (dependency.schedule_operation_id, dependency.depends_on_operation_id)
        for dependency in dependencies
    }
    for machine in set(machine_by_operation):
        queue = sorted(
            (
                operation
                for operation, assigned_machine in enumerate(machine_by_operation)
                if assigned_machine == machine
            ),
            key=lambda operation: (
                int(start_time[operation].X),
                str(operation_data[operation]["op_id"]),
            ),
        )
        for previous, current in pairwise(queue):
            edge = (operation_data[current]["op_id"], operation_data[previous]["op_id"])
            if edge not in existing_edges:
                dependencies.append(
                    ScheduleDependencySpec(
                        schedule_operation_id=edge[0],
                        depends_on_operation_id=edge[1],
                        reason="machine_queue",
                    )
                )
                existing_edges.add(edge)

    energy_values = [a.energy for a in assignments]
    salary_values = [a.machine_salary_per_minute for a in assignments]
    total_energy = (
        sum((energy for energy in energy_values if energy is not None), Decimal("0"))
        if all(energy is not None for energy in energy_values)
        else None
    )
    total_labour_cost = (
        sum(
            (
                Decimal(a.duration_minutes) * salary
                for a, salary in zip(assignments, salary_values, strict=True)
                if salary is not None
            ),
            Decimal("0"),
        )
        if all(salary is not None for salary in salary_values)
        else None
    )

    return SchedulePlan(
        assignments=tuple(assignments),
        dependencies=tuple(dependencies),
        metrics=ScheduleMetrics(
            makespan_minutes=int(makespan.X),
            total_energy=total_energy,
            total_labour_cost=total_labour_cost,
        ),
    )


def solve_fajsp(
    operations: range,
    eligible_machines: dict[int, list[int]],
    operation_data: Sequence[OpRecord],
    machine_meta: list[tuple[UUID, Decimal | None]],
    starts_at: datetime,
) -> tuple[SchedulePlan, int, bool, float]:
    """Build and solve one FAJSP instance already adapted from a `SchedulingInput`.

    Kept separate from `adapt_scheduling_input` so a caller (the scheduling
    worker) can run the solve without holding a transaction open for the
    duration of `model.optimize()`.

    Returns the plan, the solve runtime, whether the makespan is a proven optimum (`model.Status ==
    GRB.OPTIMAL`, i.e. the time limit was not hit), and the remaining optimality gap -- 0.0 when
    proven optimal, otherwise how far the returned makespan may be from the true optimum. There is
    no MIPGap target to trade off against: the solve always runs to Gurobi's default gap (proof of
    optimality) or until `TIME_LIMIT_SECONDS` elapses, whichever comes first.

    Raises:
        NoFeasibleSchedule: if the instance is infeasible (for example, a
            dependency cycle the caller failed to reject first), or if Gurobi
            found no feasible schedule within the time limit.
    """
    model, assignment, start_time, makespan = build_model(
        operations, eligible_machines, operation_data
    )

    started = time.monotonic()
    model.optimize()
    runtime_ms = int((time.monotonic() - started) * 1000)

    if model.Status == gp.GRB.INFEASIBLE:
        raise NoFeasibleSchedule("Gurobi proved no feasible schedule exists for this instance.")
    if model.SolCount == 0:
        raise NoFeasibleSchedule(
            f"Gurobi found no feasible schedule within the {TIME_LIMIT_SECONDS}s time limit."
        )

    report(operation_data, eligible_machines, assignment, start_time, makespan, model)
    plan = build_schedule_plan(
        operation_data, eligible_machines, assignment, start_time, makespan, machine_meta, starts_at
    )
    proven_optimal = model.Status == gp.GRB.OPTIMAL
    return plan, runtime_ms, proven_optimal, 0.0 if proven_optimal else model.MIPGap
