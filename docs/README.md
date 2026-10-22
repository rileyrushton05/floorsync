# Documentation

Use this folder for project process documentation.

This folder should help teaching staff understand how the team worked, what decisions were made, what risks were managed, and how the project changed over time.

## Running the project

- [Local setup and deployment](../deployment/README.md) — first run, configuration, troubleshooting
- [Accounts and signing in](accounts.md) — creating and managing logins
- [Importing production data](importing.md): the file format, the dry run, and every issue code

## Engineering conventions

- [Architecture](architecture.md)
- [Core system diagrams](diagrams/README.md) — system architecture, editable component and outbox/playback diagrams, two ERDs and two key sequence diagrams
- [Frontend architecture guide](frontend-architecture.md) — TanStack Query, feature boundaries, fixtures, and UI/backend integration
- [Scheduling and simulation backend](scheduling-simulation-backend.md) — request flows, target journeys, sequence diagrams, and implementation gaps
- [Generated OpenAPI contract](openapi.json) — run `make openapi` after changing the FastAPI API; `make openapi-check` detects an uncommitted update
- [API conventions](api-conventions.md)
- [Backend conventions](backend-conventions.md)
- [Database conventions](database-conventions.md)
- [Observability and middleware conventions](observability-conventions.md)
- [Decision records](decisions/README.md)

## Suggested Structure

```text
docs/
├── meeting-notes/
├── decisions/
└── risks/
```
