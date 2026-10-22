# Risk: Performance Under Large Scenarios

## Description

Large numbers of jobs and machines cause slow schedule generation and simulation updates, degrading the user experience and making the system impractical for real-world use.

## Likelihood

Medium

## Impact

Medium

## Mitigation Plan

- Implement pagination or filtering for dashboard data
- Use lazy loading for large data sets
- Optimize the algorithm to be O(n log n) or better where possible
- Avoid exponential-time approaches
- Implement database indexing for frequently queried fields
- **(Checkpoint 2)** Done: cursor pagination is now used end to end for jobs and machines data (a shared page-walking helper fetches every page before the scheduler preview calculates counts), closing the earlier gap where the preview only read the first 100 records
- **(Checkpoint 2)** Remaining: no large-scale timing benchmark evidence has been recorded yet, so generation-time behaviour at scale is still unproven
- **(Final, 22 Oct)** Done: benchmarks recorded. Exact proved optimality on 18 of 23 instances within 600 s; on the other 5 it returned its best schedule at the time limit, within 1.75% of the best known result. The product caps a run at 120 s

## Contingency Plan

- Reduce the default scheduling horizon (e.g., plan for only the next week instead of a month)
- Provide a "lightweight" view of the data for high-level users
- Compress data sent to the client
- Allow users to archive or archive old data

## Owner

Ben

## Status

Resolved