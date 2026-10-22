# Risk: Machine Downtime Not Supported

## Description

A facility often knows the day before that a machine will be down for maintenance. The `unavailabilities` table can store this, but there is no API or screen to enter it, and neither scheduling strategy models downtime. A schedule for a day with planned downtime has to be worked around by hand, for example by deactivating the machine.

## Likelihood

Medium

## Impact

Medium

## Mitigation Plan

- **(Final, 22 Oct)** Raised at the final review as a residual risk of the prototype
- **(Final, 22 Oct)** In place: both strategies refuse a selection whose machines have downtime (`unsupported_unavailability`), so a schedule never silently ignores it
- **(Final, 22 Oct)** In place: the limit is documented under Known limitations in [deployment/README.md](../../deployment/README.md)

## Contingency Plan

- Add an API and a settings screen for machine downtime windows
- Model downtime in the Exact strategy as fixed blocks on each machine

## Owner

Riley

## Status

Open (accepted)
