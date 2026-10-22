# Risk: Scheduling May Not Show Measurable Improvement

Merged with risk-09 (exact solver against the ReSched baseline) on 22 Oct, as both described the same gap.

## Description

The semester timeline restricts the team from implementing and fine-tuning advanced scheduling algorithms. The team's solver may then fail to beat ReSched, the baseline Pasindu provided, and without a saved comparison the measurable improvement the brief requires cannot be shown.

## Likelihood

Medium

## Impact

High

## Mitigation Plan

- Prioritise an MVP with a simple algorithm first, then iterate
- Allocate fixed time in the project plan for algorithm research and implementation
- Test the team's solver against ReSched on industry-standard benchmarks and justify the choice in the documentation
- **(Checkpoint 2)** Done: two strategies exist behind one contract (the ReSched learned policy and an exact Gurobi MILP solver, ADR 0014), selectable per run from the Planner
- **(Checkpoint 2)** Remaining: multi-objective scoring (completion time, energy, salary) is not implemented (#69, #139), and no harness runs both strategies on identical input and saves the results (#114, #115, #159)
- **(Final, 22 Oct)** Done: the Exact strategy became logic-based Benders decomposition (#326), and the harness (`scripts/bench_resched_vs_benders.py`) ran both on 23 benchmark instances. Exact beat ReSched on 22 and tied 1, 14.9% shorter on average, with a mean gap of 0.11% to the best known result. Multi-objective scoring was dropped by decision: schedules optimise makespan and report energy and labour cost

## Contingency Plan

- Document the limitations of the chosen algorithm and propose improvements for future work
- Focus on user experience and visualisation as a differentiator
- Reduce the optimisation goals to achievable targets

## Owner

Ben

## Status

Resolved
