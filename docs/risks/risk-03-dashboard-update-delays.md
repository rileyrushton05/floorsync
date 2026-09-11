# Risk: Dashboard Update Delays

## Description

Real-time dashboard updates experience delays or synchronization issues, leading to operators and managers making decisions based on outdated information about production progress.

## Likelihood

Medium

## Impact

Medium

## Mitigation Plan

- Use efficient data streaming protocols (e.g., WebSockets) instead of polling (HTTP requests)
- Optimize database queries and payload size for dashboard data endpoints
- Implement a "last updated" timestamp on the dashboard to indicate data freshness
- Use client-side caching to reduce server load

## Contingency Plan

- Display a clear warning banner when data is stale
- Allow users to manually refresh the dashboard view
- Increase server resources (if applicable) to handle the load
- Fall back to polling with reasonable intervals if WebSockets fail

## Status

Open