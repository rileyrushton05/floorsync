import json
from collections import defaultdict

from sqlalchemy.orm import Session

from floorsync_common.scheduling.exact_solver_queries import (
    load_active_machines,
    load_operations,
    load_precedences,
    load_routes,
)


def load_fajsp(path):
    with open(path) as f:
        raw = json.load(f)

    options_by_op = defaultdict(list)
    for e in raw["operations"]:
        options_by_op[e["operation"]].append((e["duration"], e["machine"]))

    op_to_job = {}
    for p in raw["precedences"]:
        op_to_job[p["before"]] = p["job"]
        op_to_job[p["after"]] = p["job"]

    # lay out ops job by job, preserving their original job IDs from the data
    ops_by_job = defaultdict(list)
    for op, j in op_to_job.items():
        ops_by_job[j].append(op)

    jobs = sorted(ops_by_job)
    op_list = []
    index_of = {}
    for j in jobs:
        for pos, op in enumerate(sorted(ops_by_job[j])):
            index_of[op] = len(op_list)
            op_list.append(
                {
                    "op_id": op,
                    "job": j,
                    "pos": pos,
                    "options": options_by_op[op],
                    "pre": [],
                    "post": [],
                }
            )

    # one pass over the raw edges
    for p in raw["precedences"]:
        b, a = index_of[p["before"]], index_of[p["after"]]
        op_list[a]["pre"].append(b)
        op_list[b]["post"].append(a)

    J = jobs
    num_machines = max(mach for e in op_list for (_, mach) in e["options"]) + 1
    R = range(num_machines)
    O = range(len(op_list))
    R_i = {i: [k for (_, k) in op_list[i]["options"]] for i in O}

    return J, R, O, R_i, op_list


def load_fajsp_from_db(db: Session):
    """Load the current floor configuration and shape it like `load_fajsp`.

    Each op_list record carries its job, its position within that job, its
    (duration, machine) options, and its direct predecessor/successor operations
    (`pre`/`post`), so `build_model` can schedule any precedence graph -- fan-in,
    fan-out, and cross-job edges included -- not just linear per-job chains.
    Each record also carries `energy_by_machine`, keyed by the same machine
    indices as `options`, so a solved schedule can be written back to the
    database with the cost snapshot `ScheduleEntry` expects.

    Besides the usual `J, R, O, R_i, op_list` returned by `load_fajsp`, this also
    returns `machine_meta`: a list of (machine_id, salary_per_minute) ordered so
    that machine index `k` in `R` corresponds to `machine_meta[k]`, letting a
    caller translate the solver's machine indices back into real machine ids.

    Raises:
        ValueError: if an operation has no compatible active machine to run on.
    """
    machine_rows = load_active_machines(db)
    operation_rows = load_operations(db)
    route_rows = load_routes(db)
    precedence_rows = load_precedences(db)

    machine_index = {
        machine_id: index for index, (machine_id, _name, _salary) in enumerate(machine_rows)
    }
    machine_meta = [(machine_id, salary) for machine_id, _name, salary in machine_rows]

    options_by_op = defaultdict(list)
    energy_by_op = defaultdict(dict)
    for operation_id, machine_id, duration, energy in route_rows:
        if machine_id in machine_index:
            index = machine_index[machine_id]
            options_by_op[operation_id].append((duration, index))
            energy_by_op[operation_id][index] = energy

    # group operations by job, ordered by their builder position as a tiebreaker
    # among operations `load_precedences` doesn't otherwise order
    ops_by_job = defaultdict(list)
    for operation_id, job_id, position in operation_rows:
        ops_by_job[job_id].append((position, operation_id))

    job_ids = sorted(ops_by_job, key=str)
    op_list = []
    index_of = {}
    for job_index, job_id in enumerate(job_ids):
        ordered_ops = [op_id for _pos, op_id in sorted(ops_by_job[job_id])]
        for pos, operation_id in enumerate(ordered_ops):
            options = options_by_op[operation_id]
            if not options:
                raise ValueError(f"Operation {operation_id} has no compatible active machine.")
            index_of[operation_id] = len(op_list)
            op_list.append(
                {
                    "op_id": operation_id,
                    "job": job_index,
                    "pos": pos,
                    "options": options,
                    "pre": [],
                    "post": [],
                    "energy_by_machine": energy_by_op[operation_id],
                }
            )

    for before_id, after_id in precedence_rows:
        b, a = index_of[before_id], index_of[after_id]
        op_list[a]["pre"].append(b)
        op_list[b]["post"].append(a)

    J = list(range(len(job_ids)))
    R = range(len(machine_rows))
    O = range(len(op_list))
    R_i = {i: [k for (_, k) in op_list[i]["options"]] for i in O}

    return J, R, O, R_i, op_list, machine_meta
