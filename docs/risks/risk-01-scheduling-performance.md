# Risk: Scheduling Algorithm Performance

## Description

The scheduling algorithm fails to generate an efficient schedule within an acceptable time frame, especially for complex scenarios. This is a core function, and poor performance would halt the entire workflow.

## Likelihood

Low

## Impact

High

## Mitigation Plan

- Implement and compare simple, well-understood heuristics (e.g., Dispatching Rules) early in the development cycle
- Conduct performance profiling on smaller datasets to identify bottlenecks
- Set a strict "time limit" for the algorithm (e.g., 5 seconds) to return a "good enough" solution, rather than seeking the optimal solution
- Use incremental scheduling to break large problems into smaller chunks
- **(Checkpoint 2)** Done: exact Gurobi solver bounded to a 120 second wall-clock budget (ADR 0014); ReSched learned policy available as a second strategy; every generated schedule passes the feasibility checker in the test suite
- **(Checkpoint 2)** Remaining: no committed one-command benchmark suite with recorded generation times per scenario yet (#142), so a regression would not be caught automatically
- **(Final, 22 Oct)** Done: one-command benchmark (`scripts/bench_resched_vs_benders.py`, since removed; `scripts/bench_lbbd_vs_resched.py` re-runs 13 of the instances; results in `evidence/benchmarks/`). ReSched took at most 0.6 s on 23 instances; Exact, now logic-based Benders decomposition (#326), stops at 120 s in the product and runs on a background worker

## Contingency Plan

- Fall back to a simpler, faster scheduling heuristic (like FIFO - First In, First Out)
- Optimize the code by moving critical parts to a more efficient data structure
- Reduce the scheduling horizon or aggregate some job operations to reduce problem size
- Display a warning to users if schedule generation exceeds expected time

## Owner

Ben

## Status

Resolved