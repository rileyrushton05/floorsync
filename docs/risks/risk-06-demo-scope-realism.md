# Risk: Demo Appears Unrealistically Clean

## Description

The static scheduling demo presents an overly clean, idealistic view of production. Without real-time disruption handling (which was explicitly placed out of scope), the demonstration may appear unrealistic to stakeholders who expect to see handling of delayed jobs and machine failures.

## Likelihood

Medium

## Impact

Low (down from Medium)

## Mitigation Plan

- Clearly communicate the scope limitation (static scheduling) in the demo script and documentation
- Add a note in the dashboard that disruptions are not automatically handled in the current version
- Show pre-configured scenarios that demonstrate what the system would look like with disruptions
- Emphasize the strength of the scheduling algorithm in baseline scenarios
- **(Checkpoint 2)** Done: the static, day-before scheduling scope (no live repair, no disruption handling) was explicitly reconfirmed with Pasindu, making this a known and agreed product boundary rather than an open design question, which lowers the impact of a viewer noticing it
- **(Checkpoint 2)** Remaining: no dashboard note or disruption-simulation mode has actually been built to communicate the limitation to a viewer, so the perception risk itself is still unmitigated

## Contingency Plan

- Add a "disruption simulation" mode that allows users to manually inject delays or failures and see the impact on the schedule
- Update the roadmap documentation to show real-time disruption handling as a future enhancement
- Add visual indicators on the dashboard showing schedule "health" and highlighting potential issues

## Status

Open