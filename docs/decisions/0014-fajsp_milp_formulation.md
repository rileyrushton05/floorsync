# Decision: Single-shot MILP for daily schedule generation

## Date

2026-09-08

## Status

Accepted

## Context

Production schedules assign flexible job-shop operations to machines and sequence them,
subject to job precedence. Schedules are generated once per planning day, ahead of the
shift they govern, and are treated as fixed once committed: nothing in the system repairs
or re-solves a schedule while it is executing. Any deviation encountered on the floor
(a late job, a machine outage) is absorbed operationally and folded into the *next* day's
regeneration rather than corrected live. The long-term scheduling objective is to trade off
three distinct costs — shift length, energy consumption, and operator labor — rather than
optimizing time alone.

The incumbent ReSched learned policy also rejects any job graph beyond a linear per-job chain
(no fan-in, fan-out, or cross-job precedence), because the pretrained checkpoint was never
trained on those shapes (#216). An exact MILP formulation has no such restriction: it accepts
any acyclic precedence graph the schema allows.

## Decision

1. Schedule generation offers two selectable strategies, chosen per run via the `strategy`
   field on the generation request: the incumbent ReSched learned policy (the default, `resched`),
   and a new exact mixed-integer linear program solved with Gurobi (`exact`). Both load the same
   `SchedulingInput` snapshot and write the same `SchedulePlan` contract, so either can be read,
   confirmed, and simulated identically once generated.
2. The exact solver's shipped objective is to minimise makespan alone. Energy and labour cost are
   computed from the solved assignment and stored on the schedule for reporting, the same as
   ReSched's output, but do not yet feed back into which assignment the solver picks. Extending the
   objective to the weighted completion-time/energy/salary sum described in Context is follow-up
   work, gated on stakeholders agreeing the weights (see Consequences) — it is not implemented by
   this decision.
3. The solve is bounded by a fixed wall-clock time budget, so a single solver invocation always
   returns within the planning window even on a hard instance:

```python
model.Params.TimeLimit = 120  # seconds; chosen to fit inside the UI's 180s poll deadline
```

   No `MIPGap` override is set: the solve runs to Gurobi's default gap (proof of optimality) unless
   the time limit is hit first, so a returned makespan is provably optimal except on the rare
   instance that does not finish in time. The task result records whether the makespan was proven
   optimal and, if not, the remaining gap.
4. No live-repair, warm-start, or incremental re-optimization path is implemented. A
   schedule is either regenerated in full on the next planning cycle, or left as-is for
   the remainder of the shift it covers.

## Rationale

- Because schedules are never repaired live, the system does not need to support
  incremental re-solving, warm-starting from a partial schedule, or reacting to real-time
  deviations within the plan itself. A single exact solve run once per day is therefore
  sufficient — there is no live-repair capability for a second, faster algorithm to serve.
- An exact MILP solve, rather than a heuristic, gives a quantifiable optimality gap against its
  objective, which a dispatching rule or metaheuristic cannot guarantee without additional
  validation machinery. It also accepts the general precedence DAGs ReSched refuses, without
  retraining or replacing the existing learned policy.
- A hard time budget means the single algorithm degrades gracefully (a feasible but not
  necessarily proven-optimal schedule) rather than failing to produce a schedule at all if the
  exact solve does not finish in time.

## Alternatives considered

- **Rolling-horizon / online re-optimization:** rejected. Adds solve-time overhead and
  implementation complexity (incremental re-solving, state tracking between solves) for a
  live-repair capability that is never exercised, since schedules are generated the day
  before execution and not adjusted afterward.
- **Dispatching rules / priority heuristics:** rejected as the primary algorithm. Faster
  to compute, but leaves the optimality gap unquantified; only reconsidered if the exact
  solve could not meet the generation-time budget, which it does.
- **Metaheuristic (e.g. genetic algorithm, tabu search) with live-repair hooks:** rejected
  for the same reason as rolling-horizon re-optimization — the repair hooks would be
  unused given the offline generation model, so the added tuning burden and
  solution-quality variance is not justified.

## Consequences

- The scheduling service only needs to support one execution mode per strategy: full
  regeneration triggered once per planning day. It does not need endpoints or state for partial
  re-solving or live repair.
- A schedule, once committed, is authoritative for the shift it covers; operational
  deviations during execution are handled outside the scheduler and reflected only in
  the next day's input data.
- If future requirements introduce live repair (e.g. real-time rescheduling on machine
  failure), this decision will need to be revisited — the current formulation and time
  budget are sized for one solve per day, not for repeated intra-day re-solves.
- The weighted completion-time/energy/salary objective described in Context is not yet built.
  Turning it on requires stakeholder-agreed weights ($w_T, w_E, w_S$), and those weights will need
  reviewing again if shift patterns, energy pricing, or labor cost structures change materially
  after they are set.

## Primary references

- `src/backend/common/floorsync_common/scheduling/gurobi_exact_solver.py` — the shipped
  formulation (`build_model`) and its Big-M derivation (`horizon`). No standalone design
  document exists yet; the code is the current source of truth for the formulation.
- [Gurobi: MIPGap and TimeLimit parameters](https://docs.gurobi.com/current/refman/parameters.html)
