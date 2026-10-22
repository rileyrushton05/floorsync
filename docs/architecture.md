# Technical Foundation

## Purpose

This document describes the FloorSync development foundation: the services that run locally, their code boundaries and the interfaces used to connect them.

## Current architecture

```mermaid
flowchart TB
    browser["Browser<br/>Next.js frontend"]
    subgraph api["FastAPI API"]
        rest["REST API /api/v1"]
        ws["WebSocket /ws"]
        relay["Outbox relay"]
        sub["Redis subscriber"]
    end
    worker["Celery worker<br/>ReSched or Exact (Gurobi + CP-SAT)"]
    redis[("Redis<br/>task queue, live-update pub/sub")]
    postgres[("PostgreSQL<br/>data, schedules, simulations, outbox")]

    browser -->|"HTTP"| rest
    browser <-->|"live updates"| ws
    rest -->|"SQLAlchemy asyncpg"| postgres
    rest -->|"enqueue generation"| redis
    redis -->|"generation task"| worker
    worker -->|"SQLAlchemy psycopg: draft schedule"| postgres
    rest -->|"publish change"| redis
    relay -->|"retry unsent outbox rows"| postgres
    relay --> redis
    redis --> sub --> ws
```

A change that dashboards must see (for example a simulation control) is written to the outbox in
the same transaction as the change, then published to Redis. Every API instance's subscriber
forwards it to its connected WebSocket clients, and the relay retries any row that was not
published ([ADR 0017](decisions/0017-live-update-outbox.md)).

## Component responsibilities

| Component | Use it for |
| --- | --- |
| `src/frontend/` | Next.js/TypeScript UI. Add application routes, reusable components and API/WebSocket clients here. |
| `src/backend/api/` | FastAPI HTTP and WebSocket transport. Add request validation, API routes and connection handling here. |
| `src/backend/common/` | Code shared by API and workers: settings, SQLAlchemy models, async sessions, typed contracts and domain utilities. |
| `src/backend/workers/` | Celery tasks that generate schedules with ReSched or Exact. Workers consume tasks from Redis. |
| `src/database/` | Alembic migrations and seed data. This is the database workstream’s ownership area. |
| Redis | Celery broker and result backend, and publish and subscribe for live updates. |
| PostgreSQL | Relational data store for application data. |

Product API code is organised by feature, while shared database infrastructure and ORM models remain
centralised. The mandatory implementation rules are defined in the
[backend conventions](backend-conventions.md) and
[observability conventions](observability-conventions.md).

The scheduling adapter is a pure shared-domain module so the API, worker and benchmark runners use
the same ReSched input/output translation. Its supported input contract and persistence boundary are
documented in [scheduling.md](scheduling.md).

## Interfaces

| Interface | Purpose |
| --- | --- |
| `/api/v1/...` | The REST API, documented at `/docs` and in [openapi.json](openapi.json) |
| `POST /api/v1/live-updates/tickets` | Issues a one-time ticket for opening the WebSocket |
| `WS /ws` | Authenticates with a ticket, then streams the changes the client subscribed to |
| `GET /health`, `/health/live`, `/health/ready`, `/health/live-updates` | Liveness and readiness checks; Compose waits on `/health/live` before starting the frontend and worker |
| Celery `scheduling` queue | Schedule generation tasks, run by the worker |

## Dependency rule

`common` is the shared kernel. Both API and workers may import it, but it must not import either of them. This avoids circular dependencies and lets the team add worker tasks or API routes independently.

```text
frontend → API → common
worker   → common
migrations → common database models
```

## Local development

Docker Compose starts frontend, API, worker, Redis and PostgreSQL together. Copy `.env.example` to `.env`, then run:

```bash
docker compose up --build -d
```

- Frontend: <http://localhost:3000>
- API health: <http://localhost:8002/health>
- API documentation: <http://localhost:8002/docs>
- WebSocket endpoint: `ws://localhost:8002/ws`

Schema changes are managed with Alembic. Add ORM models under
`floorsync_common.database.models`, import each module from that package, then run
`make db-revision name="describe the schema change"` and review the generated migration. Apply
migrations with `make db-upgrade`. In local Compose, the API startup command applies outstanding
Alembic revisions before serving and the worker waits for API health; production deployments still
run migrations as an explicit release step.

Celery workers use a separate synchronous driver and create their pool after each worker process
starts. See the
[Celery database decision](decisions/0001-celery-database-access.md).

## Quality gates

- **Docker Compose** provides the reproducible development environment for all six members.
- **Ruff** provides fast formatting and linting for Python.
- **Mypy strict** protects the contracts between the API, shared code and workers while the project is still small.
- **Pytest** begins with service health and grows with each feature.
- **TypeScript strict** applies to the Next.js frontend from the start.

Run the full backend and frontend quality suite with `make check` after running `make bootstrap`.
