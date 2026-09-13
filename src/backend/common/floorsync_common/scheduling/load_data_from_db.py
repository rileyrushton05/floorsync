"""Loader for Flexible Assembly Job Shop Problem (FAJSP) instance data."""

import json
from collections import defaultdict
from collections.abc import Sequence
from typing import NamedTuple
from uuid import UUID

from sqlalchemy.orm import Session

from floorsync_common.scheduling.exact_solver_queries import (
    load_active_machines,
    load_operations,
    load_precedences,
    load_routes,
)


class FajspData(NamedTuple):
    jobs: range
    machines: range
    operations: range
    eligible_machines: dict[int, list[int]]
    operations_list: list[dict]


def load_fajsp(path: str) -> FajspData:
    """Load an FAJSP instance and return the data needed to build the ILP model.

    Returns a FajspData namedtuple with:
        jobs:               the set of jobs, i.e. range(num_jobs)
        machines:           the set of machines, i.e. range(num_machines)
        operations:         the set of operations, i.e. range(num_operations)
        eligible_machines:  eligible machines for each operation, keyed by
                             operation index
        operations_list:    list of operation dicts, each with "job",
                             "pos" (position within its job), and "options"
                             (list of (duration, machine) pairs)
    """
    with open(path) as f:
        raw = json.load(f)

    # Group (duration, machine) options by operation id.
    options_by_operation = defaultdict(list)
    for entry in raw["operations"]:
        options_by_operation[entry["operation"]].append((entry["duration"], entry["machine"]))

    # Map operation -> job, and build predecessor/successor links.
    operation_to_job = {}
    predecessor_of = {}  # successor_op -> predecessor_op
    successor_of = {}  # predecessor_op -> successor_op

    for precedence in raw["precedences"]:
        operation_to_job[precedence["before"]] = precedence["job"]
        operation_to_job[precedence["after"]] = precedence["job"]
        predecessor_of[precedence["after"]] = precedence["before"]
        successor_of[precedence["before"]] = precedence["after"]

    # Reconstruct each job's operation chain, starting from the operation
    # with no predecessor (the "head" of the chain).
    job_ids = sorted(set(operation_to_job.values()))
    job_chains = []
    for job_id in job_ids:
        job_operations = [op for op, owning_job in operation_to_job.items() if owning_job == job_id]
        head = next(op for op in job_operations if op not in predecessor_of)

        chain = [head]
        current_op = head
        while current_op in successor_of:
            current_op = successor_of[current_op]
            chain.append(current_op)

        job_chains.append([options_by_operation[op_id] for op_id in chain])

    # Flatten the per-job chains into a single operation list.
    operations_list = []
    for job_id, chain in enumerate(job_chains):
        for pos, options in enumerate(chain):
            operations_list.append({"job": job_id, "pos": pos, "options": options})

    jobs = range(len(job_chains))
    num_machines = max(machine for op in operations_list for _, machine in op["options"]) + 1
    machines = range(num_machines)
    operations = range(len(operations_list))

    return FajspData(
        jobs, machines, operations, _eligible_machines(operations_list, operations), operations_list
    )


def _eligible_machines(operations_list: list[dict], operations: range) -> dict[int, list[int]]:
    """Return the eligible machines for each operation, keyed by operation index."""
    return {
        op: [machine for _, machine in operations_list[op]["options"]] for op in operations
    }


# if __name__ == "__main__":
#     data = load_fajsp("./data/orb1_edata.json")
#     print(f"Loaded {len(data.jobs)} jobs")
#     for job_id in data.jobs:
#         job_ops = [op for op in data.operations if data.operations_list[op]["job"] == job_id]
#         machines_used = {
#             machine
#             for op in job_ops
#             for _, machine in data.operations_list[op]["options"]
#         }
#         print(f"  job {job_id}: {len(job_ops)} tasks, uses machines {sorted(machines_used)}")


def load_fajsp_from_db(db: Session) -> FajspData:
    """Load the current floor configuration and shape it for `gurobi_exact_solver.build_model`.

    Produces the same shape `load_fajsp` builds from a benchmark JSON file: jobs are
    plain linear operation chains, which is what this solver's disjunctive model
    assumes -- `get_predecessor` in `gurobi_exact_solver.py` walks a flat, per-job list
    purely by position, with no support for fan-in, fan-out, or cross-job joins.

    Chains are derived from `dependencies`, not from `Operation.position` -- position is
    the job builder's display order, not precedence (see `database/models/operation.py`)
    -- the same source and the same one-predecessor/one-successor restriction
    `ReSchedEngine._validate` applies to its own input (`resched.py`).

    Raises:
        ValueError: If the floor configuration isn't a set of plain linear chains, or an
            operation has no compatible active machine to run on.
    """
    machine_rows = load_active_machines(db)
    operation_ids = load_operations(db)
    route_rows = load_routes(db)
    precedence_rows = load_precedences(db)

    machine_index = {machine_id: index for index, (machine_id, _name) in enumerate(machine_rows)}
    chains = _build_chains(operation_ids, precedence_rows)

    routes_by_operation: dict[UUID, list[tuple[int, int]]] = defaultdict(list)
    for operation_id, machine_id, duration in route_rows:
        if machine_id in machine_index:
            routes_by_operation[operation_id].append((duration, machine_index[machine_id]))

    operations_list = []
    for job_index, chain in enumerate(chains):
        for pos, operation_id in enumerate(chain):
            options = routes_by_operation[operation_id]
            if not options:
                raise ValueError(f"Operation {operation_id} has no compatible active machine.")
            operations_list.append({"job": job_index, "pos": pos, "options": options})

    jobs = range(len(chains))
    machines = range(len(machine_rows))
    operations = range(len(operations_list))

    return FajspData(
        jobs, machines, operations, _eligible_machines(operations_list, operations), operations_list
    )


def _build_chains(
    operation_ids: Sequence[UUID], precedence_rows: Sequence[tuple[UUID, UUID]]
) -> list[list[UUID]]:
    """Reconstruct each job's linear operation chain from precedence edges.

    Rejects any shape the exact solver's model can't represent: since it orders
    operations purely by position in a flat, per-job list, every operation needs
    exactly one predecessor and one successor -- the same restriction
    `ReSchedEngine._validate` places on its own input.
    """
    predecessor: dict[UUID, UUID] = {}
    successor: dict[UUID, UUID] = {}
    for before_id, after_id in precedence_rows:
        if after_id in predecessor or before_id in successor:
            raise ValueError(
                "The exact solver only supports one predecessor and one successor per "
                f"operation; operation {before_id!s} or {after_id!s} has more than one."
            )
        predecessor[after_id] = before_id
        successor[before_id] = after_id

    operation_id_set = set(operation_ids)
    roots = sorted((op for op in operation_id_set if op not in predecessor), key=str)

    chains = []
    for root in roots:
        chain = [root]
        while chain[-1] in successor:
            chain.append(successor[chain[-1]])
        chains.append(chain)

    covered = {operation_id for chain in chains for operation_id in chain}
    if covered != operation_id_set:
        raise ValueError(
            "Operations form a cycle the exact solver can't order: "
            f"{len(operation_id_set) - len(covered)} operation(s) unreachable from a chain root."
        )
    return chains
