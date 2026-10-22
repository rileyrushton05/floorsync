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
- **(Checkpoint 2)** Done: authenticated WebSocket live-update transport (tickets, `/ws`, subscriber, relay) merged (#292), replacing polling
- **(Checkpoint 2)** Remaining: #161, the two-instance fault-injection and recovery verification (Redis or API-instance restart, reconnect, stale-state handling), is still open, so resilience under a real failure is unproven
- **(Final, 22 Oct)** Done: #161 closed 19 Oct; integration tests cover outbox delivery, restart and cross-instance delivery (`tests/integration/test_live_update_*.py`), and clients refetch after reconnecting

## Contingency Plan

- Display a clear warning banner when data is stale
- Allow users to manually refresh the dashboard view
- Increase server resources (if applicable) to handle the load
- Fall back to polling with reasonable intervals if WebSockets fail

## Owner

Beth

## Status

Resolved