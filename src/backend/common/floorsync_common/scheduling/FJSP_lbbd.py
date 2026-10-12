"""Critical-path-search LBBD for the FJSP (Naderi & Roshanaei 2022, IJOO 4(1)).

  AMP     (Gurobi)  assignment master, (13)-(14) plus Relaxation B.2 (19)-(26)
  SSSP1   (CP-SAT)  job shop with the AMP assignment fixed, (34)-(37)
  SSSP2   (CP-SAT)  same, but the critical operations may change machine, (38)-(44),
                    repeated up to 3 times on the new critical path
  cuts              (45) from SSSP1 and (46) from each SSSP2
  CP-LBBD           warm_start=True: monolithic CP (8)-(12) for half the time,
                    its schedule and bound seed the LBBD (section 3.6)

The engine behind the `exact` strategy: `solve_fajsp` takes the arrays built by
`gurobi_exact_solver.adapt_scheduling_input` and returns the same tuple as the monolithic
`gurobi_exact_solver.solve_fajsp`, so the worker can swap one for the other.

Deviations from the paper, all deliberate:
  * CP Optimizer -> OR-Tools CP-SAT.
  * Release/tail times are head/tail variables over the precedence graph, which
    equal the paper's sums over R_jk / F_jk for chain jobs and stay valid for
    DAG jobs. Job-workload constraint (14) becomes
    Cmax >= head + duration + tail for the same reason.
  * Cuts use the subproblem's proven bound, not its incumbent, so a timed-out
    subproblem still gives a valid cut.
  * Cut strengthening (the paper names it but gives no formula): re-solve with
    only the critical operations present; if that alone forces the same
    makespan, the cut sums over the critical operations only.
  * safe_cuts=True: the paper's cut assumes taking an operation off its machine
    lowers the optimal makespan by at most p. With release times that is false:
    job a(A,1)->o(m,1)->c(C,1) and job b(m,10): with o on m the optimum is 12,
    with o elsewhere it is 10 < 12 - 1. The safe coefficient is
    p_o + (longest other op on o's machine) - 1 (shift-and-insert argument).
"""

import logging
import math
import time
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from typing import TypedDict
from uuid import UUID

import gurobipy as gp
from ortools.sat.python import cp_model

from floorsync_common.scheduling.contracts import SchedulePlan
from floorsync_common.scheduling.gurobi_exact_solver import (
    NoFeasibleSchedule,
    OpRecord,
    build_schedule_plan,
)

logger = logging.getLogger(__name__)

TIME_LIMIT_SECONDS = 120
STRATEGY = "exact_lbbd_v1"
SUB_TIME = 30  # cap on any single CP solve (s)
SSSP2_ROUNDS = 3  # paper: "three times provides a better result"

type Durations = dict[tuple[int, int], int]
type Precedences = Mapping[int, list[int]]
type CpResult = tuple[int, int, dict[int, int], dict[int, int]]
"""(makespan, proven lower bound, machine per operation, start per operation)."""


class LbbdResult(TypedDict):
    makespan: int
    lower_bound: int
    optimal: bool
    iterations: int
    machine_of: dict[int, int]
    start: dict[int, int]


def cp_solve(
    operations: Sequence[int],
    pre: Precedences,
    p: Durations,
    alts: Mapping[int, list[int]],
    time_limit: float,
) -> CpResult | None:
    """CP-SAT job shop where operation i may use machines alts[i].

    Operations missing from alts are zero-length and use no machine (still in
    the precedence graph). Returns None if no schedule was found in time.
    """
    m = cp_model.CpModel()
    horizon = sum(max(p[i, k] for k in alts[i]) for i in alts)
    start: dict[int, cp_model.IntVar] = {}
    end: dict[int, cp_model.IntVar] = {}
    lits: dict[tuple[int, int], cp_model.IntVar] = {}
    on_machine: dict[int, list[cp_model.IntervalVar]] = defaultdict(list)
    for i in operations:
        s = m.new_int_var(0, horizon, "")
        start[i] = end[i] = s
        if i not in alts:
            continue
        end[i] = m.new_int_var(0, horizon, "")
        if len(alts[i]) == 1:
            k = alts[i][0]
            on_machine[k].append(m.new_interval_var(s, p[i, k], end[i], ""))
            continue
        for k in alts[i]:
            lits[i, k] = m.new_bool_var("")
            on_machine[k].append(m.new_optional_interval_var(s, p[i, k], end[i], lits[i, k], ""))
        m.add_exactly_one(lits[i, k] for k in alts[i])
    for i in operations:
        for a in pre[i]:
            m.add(start[i] >= end[a])
    for intervals in on_machine.values():
        m.add_no_overlap(intervals)
    cmax = m.new_int_var(0, horizon, "")
    m.add_max_equality(cmax, [end[i] for i in alts])
    m.minimize(cmax)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.05, time_limit)
    solver.parameters.num_workers = 8
    if solver.solve(m) not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None
    machine_of = {
        i: alts[i][0]
        if len(alts[i]) == 1
        else next(k for k in alts[i] if solver.boolean_value(lits[i, k]))
        for i in alts
    }
    return (
        round(solver.objective_value),
        math.ceil(solver.best_objective_bound - 1e-6),
        machine_of,
        {i: solver.value(start[i]) for i in alts},
    )


def critical_path(
    operations: Sequence[int],
    pre: Precedences,
    p: Durations,
    machine_of: Mapping[int, int],
    start: Mapping[int, int],
) -> tuple[set[int], dict[int, int], int]:
    """Left-shift the schedule, then backward pass (section 3.3.3).

    Returns (all operations on any critical path, left-shifted starts, makespan).
    """
    s: dict[int, int] = {}
    e: dict[int, int] = {}
    last: dict[int, int] = {}
    machine_pred: dict[int, int | None] = {}
    for i in sorted(operations, key=lambda i: start[i]):  # preds always start earlier
        k = machine_of[i]
        machine_pred[i] = last.get(k)
        before = machine_pred[i]
        s[i] = max([e[a] for a in pre[i]] + [e[before] if before is not None else 0])
        e[i] = s[i] + p[i, k]
        last[k] = i
    makespan = max(e.values())
    stack = [i for i in operations if e[i] == makespan]
    critical = set(stack)
    while stack:
        i = stack.pop()
        for a in [*pre[i], machine_pred[i]]:
            if a is not None and a not in critical and e[a] == s[i]:
                critical.add(a)
                stack.append(a)
    return critical, s, makespan


def build_amp(
    operations: Sequence[int],
    machines: Sequence[int],
    eligible: Mapping[int, list[int]],
    pre: Precedences,
    post: Precedences,
    p: Durations,
) -> tuple[gp.Model, dict[tuple[int, int], gp.Var], gp.Var]:
    """AMP (13)-(14) with Relaxation B.2 (19)-(26). Objective is a lower bound."""
    model = gp.Model("amp")
    model.Params.OutputFlag = 0
    V = sum(max(p[i, k] for k in eligible[i]) for i in operations)

    z = {(i, k): model.addVar(vtype=gp.GRB.BINARY) for i in operations for k in eligible[i]}
    cmax = model.addVar(vtype=gp.GRB.INTEGER)
    head = {i: model.addVar() for i in operations}  # release time, sum over R_jk
    tail = {i: model.addVar() for i in operations}  # tail time, sum over F_jk
    model.setObjective(cmax, gp.GRB.MINIMIZE)

    dur = {i: gp.quicksum(p[i, k] * z[i, k] for k in eligible[i]) for i in operations}
    for i in operations:
        model.addConstr(gp.quicksum(z[i, k] for k in eligible[i]) == 1)  # (13)
        for a in pre[i]:
            model.addConstr(head[i] >= head[a] + dur[a])
        for b in post[i]:
            model.addConstr(tail[i] >= tail[b] + dur[b])
        model.addConstr(cmax >= head[i] + dur[i] + tail[i])  # (14)

    for k in machines:
        ops_k = [i for i in operations if k in eligible[i]]
        if not ops_k:
            continue
        u = model.addVar(vtype=gp.GRB.BINARY)
        e1, e2 = model.addVar(), model.addVar()  # (25)
        for e, time_of in ((e1, head), (e2, tail)):
            y = {i: model.addVar(vtype=gp.GRB.BINARY) for i in ops_k}
            model.addConstr(gp.quicksum(y.values()) == u)  # (20)
            for i in ops_k:
                model.addConstr(y[i] <= z[i, k])  # (21)
                model.addConstr(e >= time_of[i] - V * (1 - y[i]))  # (22)/(23)
        for i in ops_k:
            model.addConstr(z[i, k] <= u)  # (19)
        model.addConstr(cmax >= e1 + gp.quicksum(p[i, k] * z[i, k] for i in ops_k) + e2)  # (24)
    return model, z, cmax


def lbbd(
    operations: Sequence[int],
    machines: Sequence[int],
    eligible: Mapping[int, list[int]],
    operation_data: Sequence[OpRecord],
    time_limit: float = TIME_LIMIT_SECONDS,
    warm_start: bool = True,
    safe_cuts: bool = True,
) -> LbbdResult | None:
    """Solve one adapted instance. Returns None if no schedule was found in time.

    Defaults are what the `exact` strategy runs: safe cuts, because every precedence chain gives
    later operations a release time and the paper's cut is then unsound, and a CP warm start, so
    a usable schedule exists early even when the LBBD itself cannot close the gap.
    """
    p = {(i, k): d for i in operations for d, k in operation_data[i]["options"]}
    assert all(d > 0 for d in p.values()), "expects positive integer durations"
    pre = {i: list(operation_data[i]["pre"]) for i in operations}
    post: dict[int, list[int]] = defaultdict(list)
    for i in operations:
        for a in pre[i]:
            post[a].append(i)
    deadline = time.time() + time_limit

    def left() -> float:
        return min(SUB_TIME, deadline - time.time())

    lb, ub, iteration = 0, math.inf, 0
    best: tuple[dict[int, int], dict[int, int]] | None = None

    def offer(result: CpResult | None) -> None:
        nonlocal ub, best
        if result and result[0] < ub:
            ub, best = result[0], (result[2], result[3])

    if warm_start:  # CP-LBBD: CP gets up to half the time
        res = cp_solve(operations, pre, p, eligible, time_limit / 2)
        offer(res)
        if res:
            lb = res[1]

    amp, z, cmax = build_amp(operations, machines, eligible, pre, post, p)

    def add_cut(bound: int, machine_of: dict[int, int], start: dict[int, int]) -> set[int]:
        """(45)/(46), strengthened to the critical operations when they suffice."""
        critical, _, _ = critical_path(operations, pre, p, machine_of, start)
        cut_ops: Sequence[int] | set[int] = operations
        if len(critical) < len(operations) and time.time() < deadline:
            r = cp_solve(operations, pre, p, {i: [machine_of[i]] for i in critical}, left())
            if r and r[1] >= bound:
                cut_ops = critical
        longest: dict[int, list[int]] = defaultdict(list)
        for i in cut_ops:
            longest[machine_of[i]].append(p[i, machine_of[i]])

        def coef(i: int) -> int:
            k = machine_of[i]
            if not safe_cuts:
                return p[i, k]
            others = list(longest[k])
            others.remove(p[i, k])  # i itself
            return p[i, k] + (max(others) - 1 if others else 0)

        amp.addConstr(
            cmax >= bound - gp.quicksum(coef(i) * (1 - z[i, machine_of[i]]) for i in cut_ops)
        )
        return critical

    while lb < ub and time.time() < deadline:
        iteration += 1
        amp.Params.TimeLimit = max(0, deadline - time.time())
        amp.Params.Cutoff = ub - 0.5 if ub < math.inf else gp.GRB.INFINITY
        amp.optimize()
        # nothing under the cutoff: the incumbent is optimal
        if amp.Status != gp.GRB.TIME_LIMIT and amp.SolCount == 0:
            lb = round(ub)
            break
        if math.isfinite(amp.ObjBound):  # +-inf when the deadline left Gurobi no time at all
            lb = max(lb, math.ceil(amp.ObjBound - 1e-6))
        if amp.Status != gp.GRB.OPTIMAL or lb >= ub:
            break
        assign = {i: next(k for k in eligible[i] if z[i, k].X > 0.5) for i in operations}

        # SSSP1
        res = cp_solve(operations, pre, p, {i: [assign[i]] for i in operations}, left())
        if res is None:
            break
        offer(res)
        logger.info(
            "lbbd iteration",
            extra={"iteration": iteration, "amp": amp.ObjVal, "sssp1": res[0], "lb": lb, "ub": ub},
        )
        if lb >= ub:  # SSSP1 reached the master's proven bound: incumbent optimal
            break
        critical = add_cut(res[1], res[2], res[3])

        # SSSP2: reoptimise the machines of the critical operations
        current = res
        for _ in range(SSSP2_ROUNDS):
            if lb >= ub or time.time() >= deadline:
                break
            alts = {i: eligible[i] if i in critical else [current[2][i]] for i in operations}
            res2 = cp_solve(operations, pre, p, alts, left())
            if res2 is None:
                break
            offer(res2)
            logger.info(
                "lbbd sssp2", extra={"sssp2": res2[0], "critical_ops": len(critical), "ub": ub}
            )
            new_critical = add_cut(res2[1], res2[2], res2[3])
            if new_critical == critical:
                break
            critical, current = new_critical, res2

    if best is None:
        return None
    machine_of, start = best
    _, start, makespan = critical_path(operations, pre, p, machine_of, start)  # tidy schedule
    return LbbdResult(
        makespan=makespan,
        lower_bound=min(lb, makespan),
        optimal=lb >= makespan,
        iterations=iteration,
        machine_of=machine_of,
        start=start,
    )


def solve_fajsp(
    operations: range,
    eligible_machines: dict[int, list[int]],
    operation_data: Sequence[OpRecord],
    machine_meta: list[tuple[UUID, Decimal | None]],
    starts_at: datetime,
) -> tuple[SchedulePlan, int, bool, float]:
    """Drop-in for `gurobi_exact_solver.solve_fajsp`: (plan, runtime ms, proven optimal, gap).

    The gap is Gurobi's MIPGap definition, (makespan - lower bound) / makespan.

    Raises:
        NoFeasibleSchedule: if no schedule was found within `TIME_LIMIT_SECONDS`.
    """
    started = time.monotonic()
    result = lbbd(operations, range(len(machine_meta)), eligible_machines, operation_data)
    runtime_ms = int((time.monotonic() - started) * 1000)
    if result is None:
        raise NoFeasibleSchedule(
            f"LBBD found no feasible schedule within the {TIME_LIMIT_SECONDS}s time limit."
        )

    logger.info(
        "solved fajsp instance with lbbd",
        extra={
            "makespan_minutes": result["makespan"],
            "lower_bound": result["lower_bound"],
            "iterations": result["iterations"],
        },
    )
    plan = build_schedule_plan(
        operation_data,
        [result["machine_of"][i] for i in operations],
        [result["start"][i] for i in operations],
        result["makespan"],
        machine_meta,
        starts_at,
    )
    gap = (result["makespan"] - result["lower_bound"]) / result["makespan"]
    return plan, runtime_ms, result["optimal"], gap
