# Risk: Not Ready for a Production Deployment

## Description

FloorSync has only been run locally. There is no hosted environment, and the Docker Compose stack runs in development mode: the frontend uses the Next.js dev server and the API runs with auto-reload and the source mounted in. Deploying it for a real facility would need work the project did not cover.

## Likelihood

High

## Impact

Medium

## Mitigation Plan

- **(Final, 22 Oct)** Raised at the final review as a residual risk of the prototype
- **(Final, 22 Oct)** In place: the gap is documented under Known limitations in [deployment/README.md](../../deployment/README.md)
- **(Final, 22 Oct)** In place: with `ENVIRONMENT=production`, the API refuses to start with the committed development JWT secret, so a careless deployment cannot run with forgeable tokens

## Contingency Plan

- Build production images (a Next.js production build, the API without auto-reload or mounted source)
- Choose hosting and supply the JWT secret and database credentials through the host's secret store

## Owner

Jason

## Status

Open (accepted)
