# Risk: Scheduling Algorithm Performance

## Description

The scheduling algorithm fails to generate an efficient schedule within an acceptable time frame, especially for complex scenarios. This is a core function, and poor performance would halt the entire workflow.

## Likelihood

High

## Impact

High

## Mitigation Plan

- Implement and compare simple, well-understood heuristics (e.g., Dispatching Rules) early in the development cycle
- Conduct performance profiling on smaller datasets to identify bottlenecks
- Set a strict "time limit" for the algorithm (e.g., 5 seconds) to return a "good enough" solution, rather than seeking the optimal solution
- Use incremental scheduling to break large problems into smaller chunks

## Contingency Plan

- Fall back to a simpler, faster scheduling heuristic (like FIFO - First In, First Out)
- Optimize the code by moving critical parts to a more efficient data structure
- Reduce the scheduling horizon or aggregate some job operations to reduce problem size
- Display a warning to users if schedule generation exceeds expected time

## Status

Open