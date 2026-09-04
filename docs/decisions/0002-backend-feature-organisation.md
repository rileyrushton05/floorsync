# Decision: Pragmatic feature-first backend organisation

## Date

2026-09-02

## Status

Accepted

## Context

The initial API foundation separates all routers and schemas into horizontal directories. That is
easy to understand while the API contains only health and WebSocket endpoints, but FloorSync will
grow around distinct product areas such as machines, jobs, schedules, and simulations. A typical
feature change will otherwise require navigating and coordinating changes across several unrelated
top-level directories.

Database engines, session factories, model metadata, and migrations remain infrastructure shared by
multiple features and runtimes. They do not naturally belong to one feature slice.

## Decision

1. Organise API product code by feature. Each feature package owns its HTTP router and Pydantic
   request and response schemas.
2. Keep cross-feature API infrastructure such as database dependencies, problem responses, and
   authentication dependencies outside feature packages.
3. Keep SQLAlchemy base classes, sessions, and concrete ORM models under
   `floorsync_common.database` so the API, workers, and Alembic can import the same mappings.
4. Organise shared application and domain code by domain area under `floorsync_common`, for example
   `floorsync_common.users` and `floorsync_common.scheduling`.
5. Keep `floorsync_api.routers.api` as the `/api/v1` composition point. It includes feature routers
   but contains no feature behaviour.
6. `common` must never import `api` or `workers`.

```text
src/backend/
├── api/floorsync_api/
│   ├── features/
│   │   └── users/
│   │       ├── router.py
│   │       └── schemas.py
│   ├── dependencies/
│   ├── problems.py
│   └── routers/api.py
├── common/floorsync_common/
│   ├── users/
│   │   ├── results.py
│   │   └── service.py
│   └── database/
│       ├── models/user.py
│       ├── base.py
│       └── session.py
└── workers/floorsync_workers/
```

## Rationale

- Most development and review work is feature-shaped rather than layer-shaped.
- Colocation makes a feature's public contract easier to find and reduces cross-team merge pressure
  on global schema and router modules.
- Centralising persistence infrastructure preserves one SQLAlchemy metadata graph and one Alembic
  discovery mechanism.
- The dependency direction remains simple: API and workers may import common code, while common code
  remains independent of either runtime.

## Alternatives considered

- **Global `routers/`, `schemas/`, and `services/` directories:** simple initially, but scatters one
  feature across the repository as the product grows.
- **A completely vertical slice including its own engine, session, and model base:** rejected because
  those facilities are shared infrastructure and Alembic requires a coherent metadata graph.
- **One file per complete feature:** rejected because router, API contract, and application logic have
  different dependency rules and become difficult to test independently.

## Consequences

- Adding a feature normally creates one API feature package and, when needed, a corresponding common
  domain package and ORM model.
- HTTP schemas stay in the API package and are not passed into common services.
- ORM objects are not used as public HTTP schemas.
- Small feature packages may initially contain only `router.py` and `schemas.py`; new files are added
  only when a responsibility genuinely emerges.
- Operational routes such as health checks and WebSockets may remain in the existing router package
  because they are transports rather than product features.
