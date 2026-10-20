# Decision: The exact strategy runs critical-path-search LBBD, minimising makespan alone

## Date

2026-10-20

## Status

Accepted. Supersedes points 1 (the engine behind `exact` only) and 3 of decision 0014. Points 2
and 4 of 0014 stand: the objective is makespan alone, and there is no live repair.

## Context

Decision 0014 shipped the `exact` strategy as a single monolithic MILP in Gurobi
(`gurobi_exact_solver.build_model`): assignment binaries, big-M disjunctions for every pair of
operations sharing a machine, minimise makespan. Its LP relaxation is weak, so on mid-sized
instances it rarely proves optimality inside the time budget. A first logic-based Benders split
(`FJSP_benders.py`, #287) was no better: in the ReSched benchmark at a 10 s limit it proved
optimality on 3 of 9 Brandimarte instances, never on SD1 10x5, and found no schedule at all for
mk10 (#318).

Naderi & Roshanaei (2022) report CP-LBBD at a 0.37% average gap with 156 proven optima over 193
literature instances, against 25.5% and 49 for a plain MIP. The pieces that make the difference are
a CP sequencing subproblem, a stronger master relaxation, critical-path cuts, critical-operation
reassignment and a CP warm start (#318).

Separately, `jobs.priority` (high, med, low) can be set in the job builder, but no scheduler reads
it, so a manager may reasonably expect a high-priority job to be preferred (#302).

## Decision

1. The `exact` strategy runs critical-path-search LBBD (`scheduling/FJSP_lbbd.py`), recorded on the
   schedule as `exact_lbbd_v1` (previously `gurobi_exact_v1`). The request field stays
   `strategy: "exact"`. Gurobi solves the assignment master. OR-Tools CP-SAT solves the
   sequencing subproblems and the warm start. The module docstring lists every deliberate
   deviation from the paper.
2. The monolithic MILP (`gurobi_exact_solver.solve_fajsp`) stays in the codebase as a reference
   implementation and test oracle. Both engines share `adapt_scheduling_input`,
   `build_schedule_plan` and the `solve_fajsp` return tuple, so either can be swapped in by the
   worker. `FJSP_benders.py` is an unshipped experiment. Only the benchmark script and tests use it.
3. The time budget is one 120 s wall-clock deadline for the whole solve
   (`FJSP_lbbd.TIME_LIMIT_SECONDS`), inside the planner's 180 s poll deadline. The CP warm start
   gets up to half of it, and any single CP subproblem is capped at 30 s (`SUB_TIME`). The loop
   stops when the lower bound meets the incumbent or the deadline passes.
4. A run reports `proven_optimal` (lower bound equals makespan) and `gap`, using Gurobi's MIPGap
   definition: (makespan - lower bound) / makespan. Cuts use the subproblem's proven bound rather
   than its incumbent, so a timed-out subproblem never invalidates the lower bound.
5. Job priority is informational only. It is not part of `SchedulingInput`, and neither ReSched
   nor the exact solver uses it. A high-priority job gets no preference in a generated schedule.

## Rationale

- CP-LBBD is the variant with the published evidence of closing the gap where a plain MIP and
  plain LBBD do not (#318). It keeps what 0014 chose the exact solver for: a quantifiable gap and
  support for any acyclic precedence graph.
- The CP warm start produces a usable schedule early, even when the Benders loop cannot close the
  gap. So a hard instance still returns a schedule rather than nothing.
- Keeping makespan as the only objective means the reported gap stays meaningful. A weighted
  priority or cost term needs stakeholder-agreed weights that do not exist yet (0014, point 2).
  Leaving priority out avoids a weighting nobody has chosen.

## Alternatives considered

- **Keep the monolithic MILP:** rejected. Its weak big-M relaxation leaves large gaps on mid-sized
  instances inside 120 s.
- **Keep the first Benders split (`FJSP_benders.py`):** rejected for the benchmark results above.
- **Weight completion time by job priority in the exact solver's objective:** rejected for now.
  It would turn the objective into a weighted sum without agreed weights, and ReSched has no way
  to honour it, so the two strategies would disagree on what "better" means.

## Consequences

- A Gurobi licence is still required for `exact`, because the master runs on Gurobi. OR-Tools
  (`ortools`) is part of the `exact` extra.
- Drafts generated before this change keep the `gurobi_exact_v1` label. Run history mixes the two
  labels.
- Machine downtime (`unavailabilities`) is still not modelled. Validation reports it as
  `unsupported_unavailability` for `exact`, as before.
- The UI must not imply that priority changes a schedule (#302). If priority is ever made to count,
  this decision must be revisited together with the weights in 0014's Consequences.

## Primary references

- `src/backend/common/floorsync_common/scheduling/FJSP_lbbd.py`: the shipped engine.
- `src/backend/common/floorsync_common/scheduling/gurobi_exact_solver.py`: shared adapter and plan
  builder, and the monolithic reference MILP.
- `src/backend/workers/floorsync_workers/tasks/schedules.py`: wires `exact` to `FJSP_lbbd`.
- Naderi, B. & Roshanaei, V. (2022). *Critical-Path-Search Logic-Based Benders Decomposition
  Approaches for Flexible Job Shop Scheduling.* INFORMS Journal on Optimization 4(1):1–28.
  https://doi.org/10.1287/ijoo.2021.0056
- #318, #326 (the switch to CP-LBBD), #302 (job priority).
