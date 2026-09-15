"""Solve a Flexible Job Shop Scheduling Problem instance with Gurobi.

Builds the disjunctive MILP formulation for a floor already loaded from the
database and solves it for the minimum makespan.
"""

import logging
import time
from collections.abc import Sequence
from datetime import datetime, timedelta
from decimal import Decimal
from uuid import UUID

import gurobipy as gp

from floorsync_common.scheduling.contracts import (
    ScheduleDependencySpec,
    ScheduledOperation,
    ScheduleMetrics,
    SchedulePlan,
)
from floorsync_common.scheduling.load_data_from_db import DbOpRecord

logger = logging.getLogger(__name__)

TIME_LIMIT_SECONDS = 1800
MIP_GAP = 0.02
STRATEGY = "gurobi_exact_v1"


def processing_time(
    operation_data: Sequence[DbOpRecord], operation: int, machine: int
) -> int | None:
    """Processing time of `operation` on `machine`, or None if ineligible."""
    for duration, candidate_machine in operation_data[operation]["options"]:
        if candidate_machine == machine:
            return duration
    return None


def _required_processing_time(
    operation_data: Sequence[DbOpRecord], operation: int, machine: int
) -> int:
    """Like `processing_time`, but for call sites where `machine` is already known eligible."""
    duration = processing_time(operation_data, operation, machine)
    assert duration is not None
    return duration


def build_model(
    operations: range,
    eligible_machines: dict[int, list[int]],
    operation_data: Sequence[DbOpRecord],
) -> tuple[gp.Model, dict[tuple[int, int], gp.Var], dict[int, gp.Var], gp.Var]:
    """Build the disjunctive MILP. Returns the model and its variables."""
    horizon = sum(max(duration for duration, _ in record["options"]) for record in operation_data)

    model = gp.Model("fajsp")
    model.Params.TimeLimit = TIME_LIMIT_SECONDS
    model.Params.MIPGap = MIP_GAP

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
            _required_processing_time(operation_data, operation, machine)
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
                    + _required_processing_time(operation_data, second, machine)
                    - slack_a * horizon,
                    name=f"no_overlap_a[{first},{second},{machine}]",
                )
                slack_b = (
                    3 - assignment[first, machine] - assignment[second, machine] - sequenced_before
                )
                model.addConstr(
                    start_time[second]
                    >= start_time[first]
                    + _required_processing_time(operation_data, first, machine)
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
    operation_data: Sequence[DbOpRecord],
    eligible_machines: dict[int, list[int]],
    assignment: dict[tuple[int, int], gp.Var],
    start_time: dict[int, gp.Var],
    makespan: gp.Var,
) -> None:
    """Log the solved schedule."""
    logger.info("solved fajsp instance", extra={"makespan_minutes": int(makespan.X)})
    for operation, record in enumerate(operation_data):
        machine = next(
            candidate
            for candidate in eligible_machines[operation]
            if assignment[operation, candidate].X > 0.5
        )
        logger.info(
            "scheduled operation",
            extra={
                "job": record["job"],
                "operation_id": str(record["op_id"]),
                "machine": machine,
                "start_minutes": int(start_time[operation].X),
            },
        )


def build_schedule_plan(
    operation_data: Sequence[DbOpRecord],
    eligible_machines: dict[int, list[int]],
    assignment: dict[tuple[int, int], gp.Var],
    start_time: dict[int, gp.Var],
    makespan: gp.Var,
    machine_meta: list[tuple[UUID, Decimal | None]],
    starts_at: datetime,
) -> SchedulePlan:
    """Turn a solved model into a `SchedulePlan`, ready for `SchedulingService.store_draft`."""
    assignments: list[ScheduledOperation] = []
    for operation, record in enumerate(operation_data):
        machine = next(
            candidate
            for candidate in eligible_machines[operation]
            if assignment[operation, candidate].X > 0.5
        )
        duration = _required_processing_time(operation_data, operation, machine)
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

    dependencies = tuple(
        ScheduleDependencySpec(
            schedule_operation_id=operation_data[operation]["op_id"],
            depends_on_operation_id=operation_data[predecessor]["op_id"],
            reason="job_order",
        )
        for operation, record in enumerate(operation_data)
        for predecessor in record["pre"]
    )

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
        dependencies=dependencies,
        metrics=ScheduleMetrics(
            makespan_minutes=int(makespan.X),
            total_energy=total_energy,
            total_labour_cost=total_labour_cost,
        ),
    )


def solve_fajsp(
    operations: range,
    eligible_machines: dict[int, list[int]],
    operation_data: Sequence[DbOpRecord],
    machine_meta: list[tuple[UUID, Decimal | None]],
    starts_at: datetime,
) -> tuple[SchedulePlan, int]:
    """Build and solve one FAJSP instance already loaded from the database.

    Kept separate from the database calls on either side so a caller (the
    scheduling worker) can run the solve without holding a transaction open
    for the duration of `model.optimize()`.

    Raises:
        RuntimeError: if Gurobi found no feasible schedule within the time limit.
    """
    model, assignment, start_time, makespan = build_model(
        operations, eligible_machines, operation_data
    )

    started = time.monotonic()
    model.optimize()
    runtime_ms = int((time.monotonic() - started) * 1000)

    if model.SolCount == 0:
        raise RuntimeError(
            f"Gurobi found no feasible schedule within the {TIME_LIMIT_SECONDS}s time limit."
        )

    report(operation_data, eligible_machines, assignment, start_time, makespan)
    plan = build_schedule_plan(
        operation_data, eligible_machines, assignment, start_time, makespan, machine_meta, starts_at
    )
    return plan, runtime_ms
