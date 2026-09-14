"""Solve a Flexible Job Shop Scheduling Problem instance with Gurobi.

Loads a FAJSP instance from JSON, builds the disjunctive MILP formulation,
solves for the minimum makespan, and plots the resulting schedule.
"""

import gurobipy as gp
from sqlalchemy.orm import Session

from load_data_from_db import load_fajsp, load_fajsp_from_db

INSTANCE_PATH = './data/mk07.json'


def processing_time(operation_data, operation, machine):
    """Processing time of `operation` on `machine`, or None if ineligible."""
    for duration, candidate_machine in operation_data[operation]['options']:
        if candidate_machine == machine:
            return duration
    return None


def build_model(operations, eligible_machines, operation_data):
    """Build the disjunctive MILP. Returns the model and its variables."""
    horizon = sum(
        max(duration for duration, _ in record['options']) for record in operation_data
    )

    model = gp.Model('fajsp')

    # assignment[i, k]: operation i is assigned to machine k
    assignment = {
        (operation, machine): model.addVar(
            vtype=gp.GRB.BINARY, name=f'assign[{operation},{machine}]'
        )
        for operation in operations
        for machine in eligible_machines[operation]
    }

    # sequenced_before[i, ii]: operation i is sequenced before operation ii
    sequenced_before = {
        (first, second): model.addVar(
            vtype=gp.GRB.BINARY, name=f'before[{first},{second}]'
        )
        for first in operations
        for second in operations
        if first != second
    }

    # start_time[i]: start time of operation i
    start_time = {
        operation: model.addVar(vtype=gp.GRB.INTEGER, name=f'start[{operation}]')
        for operation in operations
    }

    makespan = model.addVar(vtype=gp.GRB.INTEGER, name='makespan')

    def duration_expression(operation):
        """Processing time of an operation as a linear expression."""
        return gp.quicksum(
            processing_time(operation_data, operation, machine) * assignment[operation, machine]
            for machine in eligible_machines[operation]
        )

    # (1) minimise the makespan
    model.setObjective(makespan, gp.GRB.MINIMIZE)

    # (2) each operation runs on exactly one eligible machine
    for operation in operations:
        model.addConstr(
            gp.quicksum(
                assignment[operation, machine] for machine in eligible_machines[operation]
            ) == 1,
            name=f'assign_once[{operation}]',
        )

    # (3) precedence: an operation starts after each of its predecessors finishes
    for operation in operations:
        for predecessor in operation_data[operation]['pre']:
            model.addConstr(
                start_time[operation] >= start_time[predecessor] + duration_expression(predecessor),
                name=f'precedence[{predecessor},{operation}]',
            )

    # (4) and (5) two operations sharing a machine cannot overlap
    for first in operations:
        for second in operations:
            if first == second:
                continue
            shared_machines = set(eligible_machines[first]) & set(eligible_machines[second])
            for machine in shared_machines:
                slack = (
                    2
                    - assignment[first, machine]
                    - assignment[second, machine]
                    + sequenced_before[first, second]
                )
                model.addConstr(
                    start_time[first]
                    >= start_time[second]
                    + processing_time(operation_data, second, machine)
                    - slack * horizon,
                    name=f'no_overlap_a[{first},{second},{machine}]',
                )
                model.addConstr(
                    start_time[second]
                    >= start_time[first]
                    + processing_time(operation_data, first, machine)
                    - (3 - assignment[first, machine] - assignment[second, machine] - sequenced_before[first, second])
                    * horizon,
                    name=f'no_overlap_b[{first},{second},{machine}]',
                )

    # (6) the makespan covers every operation
    for operation in operations:
        model.addConstr(
            makespan >= start_time[operation] + duration_expression(operation),
            name=f'makespan[{operation}]',
        )

    return model, assignment, start_time, makespan





def report(operation_data, eligible_machines, assignment, start_time, makespan):
    """Print the solved schedule to stdout."""
    print(f'makespan: {makespan.X:.0f}')
    for operation, record in enumerate(operation_data):
        machine = next(
            candidate
            for candidate in eligible_machines[operation]
            if assignment[operation, candidate].X > 0.5
        )
        print(
            f"job {record['job']} op {record['op_id']}: "
            f'machine {machine}, start {start_time[operation].X:.0f}'
        )


def main():
    jobs, machines, operations, eligible_machines, operation_data = load_fajsp(INSTANCE_PATH)
    model, assignment, start_time, makespan = build_model(operations, eligible_machines, operation_data)
    model.optimize()
    report(operation_data, eligible_machines, assignment, start_time, makespan)


def main_from_db(db: Session):
    """Solve using the floor's current jobs, machines, routes and dependencies."""
    jobs, machines, operations, eligible_machines, operation_data = load_fajsp_from_db(db)
    model, assignment, start_time, makespan = build_model(operations, eligible_machines, operation_data)
    model.optimize()
    report(operation_data, eligible_machines, assignment, start_time, makespan)


if __name__ == '__main__':
    main()
