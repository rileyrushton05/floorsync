from collections import defaultdict
from decimal import Decimal
from typing import TypedDict
from uuid import UUID

from sqlalchemy.orm import Session

from floorsync_common.scheduling.exact_solver_queries import (
    load_active_machines,
    load_operations,
    load_precedences,
    load_routes,
)


class DbOpRecord(TypedDict):
    """One operation as laid out for the solver, indexed by its position in `op_list`.

    `energy_by_machine` is keyed by the same machine indices as `options`, so a solved
    schedule can be written back to the database with the cost snapshot `ScheduleEntry`
    expects.
    """

    op_id: UUID
    job: int
    pos: int
    options: list[tuple[int, int]]
    pre: list[int]
    post: list[int]
    energy_by_machine: dict[int, Decimal | None]


def load_fajsp_from_db(
    db: Session,
) -> tuple[
    list[int],
    range,
    range,
    dict[int, list[int]],
    list[DbOpRecord],
    list[tuple[UUID, Decimal | None]],
]:
    """Load the current floor configuration for the exact solver.

    Each op_list record carries its job, its position within that job, its
    (duration, machine) options, and its direct predecessor/successor operations
    (`pre`/`post`), so `build_model` can schedule any precedence graph -- fan-in,
    fan-out, and cross-job edges included -- not just linear per-job chains.

    Besides `J, R, operations, R_i, op_list`, this also returns `machine_meta`: a
    list of (machine_id, salary_per_minute) ordered so that machine index `k` in
    `R` corresponds to `machine_meta[k]`, letting a caller translate the solver's
    machine indices back into real machine ids.

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

    options_by_op: defaultdict[UUID, list[tuple[int, int]]] = defaultdict(list)
    energy_by_op: defaultdict[UUID, dict[int, Decimal | None]] = defaultdict(dict)
    for operation_id, machine_id, duration, energy in route_rows:
        if machine_id in machine_index:
            index = machine_index[machine_id]
            options_by_op[operation_id].append((duration, index))
            energy_by_op[operation_id][index] = energy

    # group operations by job, ordered by their builder position as a tiebreaker
    # among operations `load_precedences` doesn't otherwise order
    ops_by_job: defaultdict[UUID, list[tuple[int, UUID]]] = defaultdict(list)
    for operation_id, job_id, position in operation_rows:
        ops_by_job[job_id].append((position, operation_id))

    job_ids = sorted(ops_by_job, key=str)
    op_list: list[DbOpRecord] = []
    index_of: dict[UUID, int] = {}
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
    operations = range(len(op_list))
    R_i = {i: [k for (_, k) in op_list[i]["options"]] for i in operations}

    return J, R, operations, R_i, op_list, machine_meta
