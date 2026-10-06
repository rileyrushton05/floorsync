# Risk: Single Algorithm May Underperform in Some Scenarios

## Description

The team has decided to ship a single scheduling algorithm. In some scenarios, this chosen algorithm may perform worse than a different approach. Since there's no alternative algorithm to compare against, it may be difficult to demonstrate the effectiveness of the solution in all cases.

## Likelihood

Medium (up from Low)

## Impact

High

## Mitigation Plan

- Test the chosen algorithm against industry-standard benchmarks
- Document the scenarios where the algorithm is expected to perform well
- Provide clear justification for algorithm selection in the project documentation
- Tune algorithm parameters extensively for common manufacturing scenarios
- **(Checkpoint 2)** Remaining: no naive or first-available-machine baseline exists in the codebase yet (#114, #115, #159 not started). The final report's success criteria explicitly require demonstrating measurable improvement over a naive or manual baseline, so this is now the most exposed item on the register: the risk is no longer "the algorithm might lose to a baseline," it is "there is no baseline to compare against at all." This risk and `risk-04` describe the same gap from two angles and should be read together.

## Contingency Plan

- If the algorithm consistently underperforms, re-evaluate the choice and implement a different algorithm
- Include a baseline comparison in documentation, even if not implemented in the system
- Acknowledge in project limitations that the algorithm may not be optimal for all scenarios
- Allow users to configure algorithm parameters to suit their specific needs

## Status

Open