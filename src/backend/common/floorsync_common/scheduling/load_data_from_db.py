"""Loader for Flexible Assembly Job Shop Problem (FAJSP) instance data."""

import json
from collections import defaultdict
from typing import NamedTuple


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
    eligible_machines = {
        op: [machine for _, machine in operations_list[op]["options"]] for op in operations
    }

    return FajspData(jobs, machines, operations, eligible_machines, operations_list)


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
