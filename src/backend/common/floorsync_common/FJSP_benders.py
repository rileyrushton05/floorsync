"""Logic-based Benders decomposition for the Flexible Job Shop Scheduling Problem.

The monolithic model in gurobi_exact_solver.py decides assignment and sequencing at
once. Here the two halves are split:

  master (MILP)      pick a machine for each operation, minimising a relaxation
                     of the makespan -- gives a lower bound
  subproblem (MILP)  with the machines fixed the instance is a plain job shop;
                     sequence it and get the true makespan -- gives an upper bound

The master learns from each subproblem through a Benders optimality cut

    Cmax >= h - sum_{i in S} p[i, m(i)] * (1 - x[i, m(i)])

read as "as long as the operations in S stay where they are, the makespan cannot
drop below h, and moving one of them off its machine can buy back at most its
processing time". The second half is valid because for any fixed sequencing the
makespan is a longest path, and a path visits an operation at most once, so
zeroing p_i shortens it by at most p_i; moving i to another machine only adds
work elsewhere. S is shrunk by strengthen_cut() before the cut is added.
"""

import time
from uuid import UUID

import gurobipy as gp

from floorsync_common.scheduling.gurobi_exact_solver import (
    OpRecord,
    build_model,
    required_processing_time,
)
from floorsync_common.seed.flexible import load_flexible_instance

INSTANCE_NAME = "fattahi1"
MAX_ITERATIONS = 500


class OutOfTime(Exception):
    """A subproblem hit the deadline before proving its makespan.

    Its value is then only an upper bound, so neither a cut nor strengthen_cut()
    may use it; `incumbent` still carries the feasible schedule, if any.
    """

    def __init__(self, incumbent: tuple[int, dict[int, int]] | None) -> None:
        super().__init__("subproblem ran out of time")
        self.incumbent = incumbent


def load_fajsp(
    name: str,
) -> tuple[list[int], list[int], range, dict[int, list[int]], list[OpRecord]]:
    """Load a seeded benchmark instance for the Benders/monolithic comparison in `demo()`.

    Reuses the production `load_flexible_instance` parser rather than a second JSON reader, and
    wraps each small integer operation id in a UUID (`UUID(int=op_id)`) so the resulting records are
    real `OpRecord`s -- the same type `gurobi_exact_solver.build_model` and `processing_time` are
    typed against -- instead of a parallel, structurally-similar type to keep in sync by hand.
    """
    instance = load_flexible_instance(name)
    op_ids = sorted(instance.operations_by_id)
    index_of = {op_id: index for index, op_id in enumerate(op_ids)}
    machine_labels = sorted(
        {candidate.machine for op in instance.operations for candidate in op.candidates}
    )
    machine_index = {label: index for index, label in enumerate(machine_labels)}

    operation_data: list[OpRecord] = []
    for op_id in op_ids:
        operation_data.append(
            {
                "op_id": UUID(int=op_id),
                "options": [
                    (candidate.duration, machine_index[candidate.machine])
                    for candidate in instance.operations_by_id[op_id].candidates
                ],
                "pre": [],
                "energy_by_machine": {},
            }
        )
    for before, after in instance.dependencies:
        operation_data[index_of[after]]["pre"].append(index_of[before])

    operations = range(len(operation_data))
    eligible_machines = {i: [k for _, k in operation_data[i]["options"]] for i in operations}
    return (
        list(instance.job_labels),
        list(range(len(machine_labels))),
        operations,
        eligible_machines,
        operation_data,
    )


def build_master(
    operations: range,
    machines: list[int],
    eligible_machines: dict[int, list[int]],
    operation_data: list[OpRecord],
    p: dict[tuple[int, int], int],
) -> tuple[gp.Model, dict[tuple[int, int], gp.Var], gp.Var]:
    """Assignment-only master. Its objective is a lower bound on the makespan."""
    model = gp.Model("benders_master")
    model.Params.OutputFlag = 0

    x = {
        (i, k): model.addVar(vtype=gp.GRB.BINARY, name=f"assign[{i},{k}]")
        for i in operations
        for k in eligible_machines[i]
    }
    cmax = model.addVar(name="cmax")
    # tail[i]: longest chain of work from operation i to the end of its job
    tail = {i: model.addVar(name=f"tail[{i}]") for i in operations}

    model.setObjective(cmax, gp.GRB.MINIMIZE)

    def duration(i: int) -> gp.LinExpr:
        return gp.quicksum(p[i, k] * x[i, k] for k in eligible_machines[i])

    # `post`, the reverse of each operation's `pre`, isn't stored on `OpRecord` (nothing else
    # needs it), so it's derived here instead of adding a field the rest of the solver never reads.
    successors: dict[int, list[int]] = {i: [] for i in operations}
    for i in operations:
        for predecessor in operation_data[i]["pre"]:
            successors[predecessor].append(i)

    for i in operations:
        model.addConstr(gp.quicksum(x[i, k] for k in eligible_machines[i]) == 1)

        # (relaxation 1) the makespan covers the critical path of every job
        model.addConstr(tail[i] >= duration(i))
        for successor in successors[i]:
            model.addConstr(tail[i] >= duration(i) + tail[successor])
        model.addConstr(cmax >= tail[i])

    # (relaxation 2) no machine can finish before it has done all its own work
    for k in machines:
        model.addConstr(
            cmax >= gp.quicksum(p[i, k] * x[i, k] for i in operations if k in eligible_machines[i])
        )

    return model, x, cmax


def solve_subproblem(
    operations: range,
    operation_data: list[OpRecord],
    machine_of: dict[int, int],
    p: dict[tuple[int, int], int],
    enforced: set[int] | None = None,
    deadline: float = float("inf"),
) -> tuple[int, dict[int, int]]:
    """Job shop with the assignment fixed. Returns (makespan, start times).

    `enforced` limits which machines get their no-overlap constraints; leaving a
    machine out relaxes the problem, which strengthen_cut() uses to find out
    which machines the makespan actually depends on.
    """
    # ponytail: the subproblem is a disjunctive MILP, which is what Gurobi is
    # already here for. A CP solver (CP-SAT's NoOverlap) is the usual choice and
    # is much faster on the bigger instances -- swap this function if it bites.
    horizon = sum(p[i, machine_of[i]] for i in operations)

    model = gp.Model("benders_sub")
    model.Params.OutputFlag = 0
    if deadline != float("inf"):
        model.Params.TimeLimit = max(0.0, deadline - time.time())

    start = {i: model.addVar(vtype=gp.GRB.INTEGER, ub=horizon) for i in operations}
    cmax = model.addVar(vtype=gp.GRB.INTEGER, ub=horizon)
    model.setObjective(cmax, gp.GRB.MINIMIZE)

    for i in operations:
        for predecessor in operation_data[i]["pre"]:
            model.addConstr(
                start[i] >= start[predecessor] + p[predecessor, machine_of[predecessor]]
            )
        model.addConstr(cmax >= start[i] + p[i, machine_of[i]])

    # only operations that ended up on the same machine can clash
    on_machine: dict[int, list[int]] = {}
    for i in operations:
        on_machine.setdefault(machine_of[i], []).append(i)

    for k, shared in on_machine.items():
        if enforced is not None and k not in enforced:
            continue
        for position, first in enumerate(shared):
            for second in shared[position + 1 :]:
                before = model.addVar(vtype=gp.GRB.BINARY)
                model.addConstr(
                    start[second]
                    >= start[first] + p[first, machine_of[first]] - horizon * (1 - before)
                )
                model.addConstr(
                    start[first] >= start[second] + p[second, machine_of[second]] - horizon * before
                )

    model.optimize()
    if model.Status == gp.GRB.TIME_LIMIT:
        raise OutOfTime(
            (round(cmax.X), {i: round(start[i].X) for i in operations}) if model.SolCount else None
        )
    if model.SolCount == 0:
        raise RuntimeError("subproblem found no schedule")
    return round(cmax.X), {i: round(start[i].X) for i in operations}


def strengthen_cut(
    operations: range,
    operation_data: list[OpRecord],
    machine_of: dict[int, int],
    p: dict[tuple[int, int], int],
    makespan: int,
    deadline: float = float("inf"),
) -> set[int]:
    """Smallest set of machines that on their own still force `makespan`.

    Drop a machine's no-overlap constraints; if the relaxed job shop still takes
    as long, that machine was not what made the schedule long, so the cut does
    not need to mention any of its operations. Fewer terms, tighter cut.
    """
    # ponytail: one extra subproblem solve per machine, per iteration. Worth it
    # -- without the shrinking the cuts barely move the bound -- but if the
    # per-iteration cost hurts, take the machines on one critical path instead.
    needed = set(machine_of.values())
    for k in sorted(needed):
        candidate = needed - {k}
        relaxed, _ = solve_subproblem(
            operations, operation_data, machine_of, p, enforced=candidate, deadline=deadline
        )
        if relaxed >= makespan:
            needed = candidate
    return needed


def benders(
    jobs: list[int],
    machines: list[int],
    operations: range,
    eligible_machines: dict[int, list[int]],
    operation_data: list[OpRecord],
    max_iterations: int = MAX_ITERATIONS,
    time_limit: float | None = None,
    verbose: bool = True,
    history: list[tuple[float, float, float]] | None = None,
) -> tuple[int, dict[int, int], dict[int, int], int]:
    """Run the cut loop. Returns (makespan, machine_of, start_times, iterations).

    Stops early on `max_iterations` or `time_limit` seconds, in which case the
    best schedule found is returned and the remaining gap is printed. Pass a
    `history` list to have (seconds elapsed, lower bound, upper bound) appended
    after every iteration; its last entry holds the final, still-valid bounds.
    """
    started = time.time()
    deadline = started + time_limit if time_limit else float("inf")
    p = {
        (i, k): required_processing_time(operation_data, i, k)
        for i in operations
        for k in eligible_machines[i]
    }
    master, x, cmax = build_master(operations, machines, eligible_machines, operation_data, p)

    lower_bound: float = 0
    upper_bound: float = float("inf")
    best: tuple[dict[int, int], dict[int, int]] | None = None
    iteration = 0

    def record() -> None:
        if history is not None:
            history.append((time.time() - started, lower_bound, upper_bound))

    for iteration in range(1, max_iterations + 1):
        if deadline != float("inf"):
            master.Params.TimeLimit = max(0.0, deadline - time.time())
        master.optimize()
        if master.Status == gp.GRB.TIME_LIMIT:
            print(f"out of time, gap still [{lower_bound:.1f}, {upper_bound:.0f}]")
            break
        if master.Status == gp.GRB.INFEASIBLE:
            # every assignment left is one a cut ruled no better than the
            # incumbent, so the incumbent is optimal
            lower_bound = upper_bound
            break
        if master.Status != gp.GRB.OPTIMAL:
            raise RuntimeError(f"master ended with status {master.Status}")
        lower_bound = master.ObjVal

        machine_of = {
            i: next(k for k in eligible_machines[i] if x[i, k].X > 0.5) for i in operations
        }
        try:
            makespan, start_times = solve_subproblem(
                operations, operation_data, machine_of, p, deadline=deadline
            )
        except OutOfTime as timeout:
            if timeout.incumbent is not None and timeout.incumbent[0] < upper_bound:
                upper_bound, best = timeout.incumbent[0], (machine_of, timeout.incumbent[1])
            record()
            print(f"out of time, gap still [{lower_bound:.1f}, {upper_bound:.0f}]")
            break
        if makespan < upper_bound:
            upper_bound, best = makespan, (machine_of, start_times)
        record()

        if verbose:
            print(
                f"iter {iteration:3d}  LB {lower_bound:7.1f}  UB {upper_bound:6.0f}"
                f"  (this assignment: {makespan})"
            )

        if upper_bound - lower_bound < 1:  # durations are integral
            break
        if time.time() > deadline:
            print(f"out of time, gap still [{lower_bound:.1f}, {upper_bound:.0f}]")
            break

        try:
            critical = strengthen_cut(
                operations, operation_data, machine_of, p, makespan, deadline=deadline
            )
        except OutOfTime:
            print(f"out of time, gap still [{lower_bound:.1f}, {upper_bound:.0f}]")
            break
        cut_ops = [i for i in operations if machine_of[i] in critical]

        master.addConstr(
            cmax
            >= makespan
            - gp.quicksum(p[i, machine_of[i]] * (1 - x[i, machine_of[i]]) for i in cut_ops)
        )
        # nothing better than `makespan` lives behind this assignment, and the
        # incumbent already has it -- so forbid it outright and keep moving
        master.addConstr(gp.quicksum(x[i, machine_of[i]] for i in cut_ops) <= len(cut_ops) - 1)
    else:
        print(
            f"hit the {max_iterations} iteration limit, "
            f"gap still [{lower_bound:.1f}, {upper_bound:.0f}]"
        )

    if best is None:
        raise RuntimeError("Benders found no schedule within the time limit")
    record()  # the optimal-by-infeasible-master exit moves the lower bound up to the incumbent
    return round(upper_bound), best[0], best[1], iteration


def main() -> None:
    jobs, machines, operations, eligible_machines, operation_data = load_fajsp(INSTANCE_NAME)
    makespan, machine_of, start_times, iterations = benders(
        jobs, machines, operations, eligible_machines, operation_data
    )

    print(f"\nmakespan: {makespan} (after {iterations} Benders iterations)")
    for i, record in enumerate(operation_data):
        print(f"op {record['op_id'].int}: machine {machine_of[i]}, start {start_times[i]}")


def demo() -> None:
    """Benders must reach the same makespan as the monolithic model.

    `behnke58` and `dafjs01` are also seeded flexible instances but are large enough that both
    solvers can take minutes; left out so this stays a fast smoke test, not a benchmark run.
    """
    for name in ("fattahi1", "kacem1"):
        jobs, machines, operations, eligible_machines, operation_data = load_fajsp(name)

        model, _, _, reference = build_model(operations, eligible_machines, operation_data)
        model.Params.OutputFlag = 0
        model.optimize()

        makespan, machine_of, start_times, iterations = benders(
            jobs, machines, operations, eligible_machines, operation_data, verbose=False
        )
        assert makespan == round(reference.X), (
            f"{name}: benders {makespan} != monolithic {reference.X}"
        )

        # and the schedule it hands back must actually be feasible
        for i in operations:
            duration = required_processing_time(operation_data, i, machine_of[i])
            assert start_times[i] + duration <= makespan
            for predecessor in operation_data[i]["pre"]:
                predecessor_duration = required_processing_time(
                    operation_data, predecessor, machine_of[predecessor]
                )
                assert start_times[i] >= start_times[predecessor] + predecessor_duration
            for other in operations:
                if other != i and machine_of[other] == machine_of[i]:
                    other_duration = required_processing_time(
                        operation_data, other, machine_of[other]
                    )
                    assert (
                        start_times[other] >= start_times[i] + duration
                        or start_times[i] >= start_times[other] + other_duration
                    )

        print(f"{name}: makespan {makespan} in {iterations} iterations, matches monolithic")


if __name__ == "__main__":
    main()
