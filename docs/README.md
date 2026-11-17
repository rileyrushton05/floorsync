# Documentation

How FloorSync is built, how the team worked, and why it was built this way. Setup is in
[deployment/](../deployment/README.md) and requirements are in [spec/](../spec/README.md).

## Using the system

- [Accounts and signing in](accounts.md): the manager account, operator logins and their passwords
- [Importing production data](importing.md): the file formats, the dry run and every issue code, with an [example file](examples/import-example.json)

## Design and architecture

- [Architecture](architecture.md): the C4 container and component diagrams, code boundaries and local development
- [System diagrams](diagrams/README.md): every diagram with its editable source: architecture, outbox and playback patterns, ERDs and sequences
- [Scheduling](scheduling.md): the scheduling problem, input validation and the ReSched adapter (the Exact strategy is described in [ADR 0014](decisions/0014-fajsp_milp_formulation.md) and its code)
- [Scheduling and simulation backend](scheduling-simulation-backend.md): request flows and sequence diagrams from generation to simulation
- [Database schema](database-schema.md), with the production and schedule ERDs and the [physical schema](diagrams/data/physical-schema.png)
- [Frontend architecture](frontend-architecture.md): TanStack Query, feature boundaries and UI to API integration
- [OpenAPI contract](openapi.json): generated with `make openapi`; CI fails if it is out of date

## Engineering conventions

- [Backend](backend-conventions.md), [API](api-conventions.md), [database](database-conventions.md) and [observability](observability-conventions.md) conventions
- [Pull requests](pull-requests.md) and [contributing](../CONTRIBUTING.md)

## Project records

- [Decision records](decisions/README.md): 20 ADRs with context, decision and alternatives
- [Risk register](risks/README.md): each risk with mitigation, owner and outcome
- [External resources and AI use](external-resources/README.md): third-party code, data, papers and tools
