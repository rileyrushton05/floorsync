"""Mixed-integer programming model for the Flexible Assembly Job Shop
Problem (FAJSP), built with Gurobi.
"""

import gurobipy as gp
from gurobipy import GRB
from load_data_from_db import load_fajsp

DATA_PATH = "./data/mk01.json"


def get_predecessor(operation: int, operations_list: list[dict]) -> int | None:
    """Return the operation index that immediately precedes `operation`
    within the same job, or None if `operation` is the first task of
    its job (i.e. it has no predecessor).
    """
    if operations_list[operation]["pos"] == 0:
        return None
    return operation - 1  # jobs are laid out contiguously, so i-1 is the prior task


def get_processing_time(operation: int, machine: int, operations_list: list[dict]) -> int | None:
    """Return the processing time of `operation` on `machine`, or None
    if `machine` is not an eligible machine for `operation`.
    """
    for duration, candidate_machine in operations_list[operation]["options"]:
        if candidate_machine == machine:
            return duration
    return None


def build_model(
    jobs: list,
    machines: list,
    operations: list[int],
    eligible_machines: dict[int, list[int]],
    operations_list: list[dict],
) -> gp.Model:
    """Build the FAJSP MILP model. Does not call optimize()."""

    # Upper bound on the makespan: sum of each operation's worst-case duration.
    big_m = sum(max(duration for duration, _ in op["options"]) for op in operations_list)

    model = gp.Model("fajsp")

    # assignment[op, machine] = 1 if operation `op` is assigned to `machine`.
    assignment = {
        (op, machine): model.addVar(vtype=GRB.BINARY)
        for op in operations
        for machine in eligible_machines[op]
    }

    # sequenced_before[op, other_op] = 1 if `op` is sequenced before `other_op`
    # (only meaningful when both are assigned to the same machine).
    sequenced_before = {
        (op, other_op): model.addVar(vtype=GRB.BINARY)
        for op in operations
        for other_op in operations
        if op != other_op
    }

    # start_time[op] = start time of operation `op`.
    start_time = {op: model.addVar(vtype=GRB.INTEGER) for op in operations}

    # makespan = completion time of the last operation to finish.
    makespan = model.addVar(vtype=GRB.INTEGER)

    # (1) Minimize the makespan.
    model.setObjective(makespan)

    # (2) Each operation is assigned to exactly one eligible machine.
    for op in operations:
        model.addConstr(
            gp.quicksum(assignment[op, machine] for machine in eligible_machines[op]) == 1
        )

    # (3) Precedence: an operation cannot start before its predecessor
    #     (within the same job) has finished.
    for op in operations:
        predecessor = get_predecessor(op, operations_list)
        if predecessor is None:
            continue
        model.addConstr(
            start_time[op]
            >= start_time[predecessor]
            + gp.quicksum(
                get_processing_time(predecessor, machine, operations_list)
                * assignment[predecessor, machine]
                for machine in eligible_machines[predecessor]
            )
        )

    # (4) & (5) Machine disjunctive constraints: if two operations share a
    #     machine, one must finish before the other starts, in whichever
    #     order `sequenced_before` dictates.
    for op in operations:
        for other_op in operations:
            if op == other_op:
                continue
            shared_machines = set(eligible_machines[op]) & set(eligible_machines[other_op])
            for machine in shared_machines:
                op_duration = get_processing_time(op, machine, operations_list)
                other_op_duration = get_processing_time(other_op, machine, operations_list)

                # (4) If both ops use `machine` and `op` is sequenced before
                #     `other_op`, then `op` must start after `other_op` finishes
                #     -- wait, direction enforced below by sequenced_before.
                model.addConstr(
                    start_time[op]
                    >= start_time[other_op]
                    + other_op_duration
                    - (
                        2
                        - assignment[op, machine]
                        - assignment[other_op, machine]
                        + sequenced_before[op, other_op]
                    )
                    * big_m
                )

                # (5) The complementary ordering constraint.
                model.addConstr(
                    start_time[other_op]
                    >= start_time[op]
                    + op_duration
                    - (
                        3
                        - assignment[op, machine]
                        - assignment[other_op, machine]
                        - sequenced_before[op, other_op]
                    )
                    * big_m
                )

    # (6) The makespan is at least the completion time of every operation.
    for op in operations:
        model.addConstr(
            makespan
            >= start_time[op]
            + gp.quicksum(
                get_processing_time(op, machine, operations_list) * assignment[op, machine]
                for machine in eligible_machines[op]
            )
        )

    return model


def main() -> None:
    jobs, machines, operations, eligible_machines, operations_list = load_fajsp(DATA_PATH)
    model = build_model(jobs, machines, operations, eligible_machines, operations_list)
    model.optimize()


if __name__ == "__main__":
    main()
