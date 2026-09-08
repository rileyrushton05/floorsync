# Decision: Single-shot MILP for daily schedule generation

## Date

2026-09-08

## Status

Pending

## Context

Production schedules assign flexible job-shop operations to machines and sequence them,
subject to job precedence. Schedules are generated once per planning day, ahead of the
shift they govern, and are treated as fixed once committed: nothing in the system repairs
or re-solves a schedule while it is executing. Any deviation encountered on the floor
(a late job, a machine outage) is absorbed operationally and folded into the *next* day's
regeneration rather than corrected live. The scheduling objective must trade off three
distinct costs — shift length, energy consumption, and operator labor — rather than
optimizing time alone.

## Decision

1. Schedules are produced by a single exact mixed-integer linear program (MILP), solved
   once per planning day. See `docs/design/fajsp_milp_formulation.md` for the full
   formulation.
2. The objective is a weighted sum of completion time, energy cost, and salary cost
   (formulation §6), with weights set as an operational input rather than hardcoded.
3. The solve is bounded by a fixed wall-clock time budget with an acceptable optimality
   gap fallback, so a single solver invocation always returns a usable schedule within
   the planning window:

```python
m.Params.TimeLimit = 1800       # seconds; hard budget
m.Params.MIPGap = 0.02          # accept within 2% of best known bound if TimeLimit is hit
```

4. No live-repair, warm-start, or incremental re-optimization path is implemented. A
   schedule is either regenerated in full on the next planning cycle, or left as-is for
   the remainder of the shift it covers.

## Rationale

- Because schedules are never repaired live, the system does not need to support
  incremental re-solving, warm-starting from a partial schedule, or reacting to real-time
  deviations within the plan itself. A single exact solve run once per day is therefore
  sufficient — there is no live-repair capability for a second, faster algorithm to serve.
- An exact MILP solve, rather than a heuristic, gives a quantifiable optimality gap
  against the stated objective (§6 of the formulation), which a dispatching rule or
  metaheuristic cannot guarantee without additional validation machinery.
- A hard time budget with a gap-tolerance fallback means the single algorithm degrades
  gracefully (a slightly suboptimal but feasible schedule) rather than failing to produce
  a schedule at all if the exact solve does not finish in time.

## Alternatives considered

- **Rolling-horizon / online re-optimization:** rejected. Adds solve-time overhead and
  implementation complexity (incremental re-solving, state tracking between solves) for a
  live-repair capability that is never exercised, since schedules are generated the day
  before execution and not adjusted afterward.
- **Dispatching rules / priority heuristics:** rejected as the primary algorithm. Faster
  to compute, but leaves the optimality gap against the completion-time/energy/salary
  objective unquantified; only reconsidered if the exact solve could not meet the
  generation-time budget, which it does.
- **Metaheuristic (e.g. genetic algorithm, tabu search) with live-repair hooks:** rejected
  for the same reason as rolling-horizon re-optimization — the repair hooks would be
  unused given the offline generation model, so the added tuning burden and
  solution-quality variance is not justified.

## Consequences

- The scheduling service only needs to support one execution mode: full regeneration
  triggered once per planning day. It does not need endpoints or state for partial
  re-solving or live repair.
- A schedule, once committed, is authoritative for the shift it covers; operational
  deviations during execution are handled outside the scheduler and reflected only in
  the next day's input data.
- If future requirements introduce live repair (e.g. real-time rescheduling on machine
  failure), this decision will need to be revisited — the current formulation and time
  budget are sized for one solve per day, not for repeated intra-day re-solves.
- The objective weights ($w_T, w_E, w_S$) and the generation-time budget are operational
  parameters that must be agreed with stakeholders and reviewed if shift patterns, energy
  pricing, or labor cost structures change materially.

## Primary references

- `docs/design/fajsp_milp_formulation.md` — full MILP formulation, objective definition,
  and Big-M derivation.
- [Gurobi: MIPGap and TimeLimit parameters](https://docs.gurobi.com/current/refman/parameters.html)