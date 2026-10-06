# Risk: Limited Time for Advanced Optimization

## Description

The semester timeline restricts the team from implementing and fine-tuning advanced scheduling algorithms, limiting the project to a simple approach that may not demonstrate significant improvements.

## Likelihood

Medium

## Impact

Medium

## Mitigation Plan

- Prioritize a Minimum Viable Product (MVP) with a simple algorithm first
- Allocate specific, non-negotiable time in the project plan for algorithm research and implementation
- Choose a single, promising algorithm to focus on, rather than attempting multiple complex ones
- Start with the simplest working algorithm and iterate
- **(Checkpoint 2)** Done: two scheduling strategies exist (the ReSched learned policy and an exact Gurobi MILP solver, ADR 0014), superseding the original "single simple heuristic" assumption
- **(Checkpoint 2)** Remaining: multi-objective scoring across completion time, energy usage and operator salary is not implemented; the exact solver's objective is makespan alone, with the rest explicitly deferred as follow-up work in ADR 0014 (#69, #139 still open). This risk and `risk-09` describe the same underlying gap from two angles and should be merged at the next revision.

## Contingency Plan

- Document the limitations of the chosen algorithm and propose improvements for future work
- Focus on user experience and data visualization as a key differentiator, even if the algorithm is simple
- Reduce scope of optimization goals to achievable targets

## Status

Open