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

## Contingency Plan

- Reduce the default scheduling horizon (e.g., plan for only the next week instead of a month)
- Provide a "lightweight" view of the data for high-level users
- Compress data sent to the client
- Allow users to archive or archive old data

## Status

Open