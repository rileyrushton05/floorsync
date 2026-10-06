# Risk: Exact Solver May Underperform the ReSched Baseline, Unproven Either Way

## Description

The exact Gurobi solver the team built may perform worse than ReSched, the learned policy Pasindu provided as the project's baseline, in some scenarios. Without a saved, run comparison between the two, it may be difficult to demonstrate the effectiveness of the solution in all cases.

## Likelihood

Medium

## Impact

High

## Mitigation Plan

- Test the exact solver against ReSched on industry-standard benchmarks
- Document the scenarios where the exact solver is expected to perform well
- Provide clear justification for algorithm selection in the project documentation
- Tune solver parameters extensively for common manufacturing scenarios
- **(Checkpoint 2)** Done: both algorithms exist and share one contract, so either can be selected per run from the Planner (ReSched as the baseline, Exact as the team's own contribution)
- **(Checkpoint 2)** Remaining: no automated harness yet runs both on identical input and records makespan, utilisation, cost and computation time as saved evidence (#114, #115, #159 not started), so the measurable improvement the final report's success criteria require is still unproven even though both algorithms are ready. This risk and `risk-04` describe the same gap from two angles and should be read together.

## Contingency Plan

- If the algorithm consistently underperforms, re-evaluate the choice and implement a different algorithm
- Include a baseline comparison in documentation, even if not implemented in the system
- Acknowledge in project limitations that the algorithm may not be optimal for all scenarios
- Allow users to configure algorithm parameters to suit their specific needs

## Status

Open