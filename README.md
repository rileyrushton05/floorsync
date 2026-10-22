# FloorSync

Job shop scheduling, simulation and live operations management. DECO3801 project 13, Team 61
(Cuffington & Co).

A production coordinator selects jobs and generates a schedule that assigns every operation to a
compatible machine with start and end times. The schedule then plays out in a time-driven
simulation, while managers watch every machine and job on a live overview and each operator follows
their own machine's queue.

## Getting started

With [Docker](https://docs.docker.com/get-docker/) running:

```bash
git clone --recurse-submodules <repository-url>
cd team-61-cuffington-and-co
deployment/run-local.sh
```

Open <http://localhost:3000> and sign in as `manager` / `floorsync-dev`. The API documentation is at
<http://localhost:8002/docs>.

**[deployment/README.md](deployment/README.md) is the full guide**: what the script does step by
step, the deployment files, a demo walkthrough, the optional Gurobi licence for the Exact strategy,
configuration, troubleshooting and known limitations.

## Stack

| Part | Technology |
| --- | --- |
| Frontend | Next.js, React, TypeScript, TanStack Query |
| API | FastAPI, SQLAlchemy (async), Alembic |
| Scheduling worker | Celery; ReSched (learned policy) and an exact solver (Gurobi with OR-Tools CP-SAT) |
| Data and messaging | PostgreSQL, Redis |
| Runtime | Docker Compose |

[docs/architecture.md](docs/architecture.md) describes the components and their boundaries.

## Repository map

```text
.
├── deployment/          setup guide and run-local.sh
├── design/              design artefacts
├── docs/                architecture, conventions, decision records, risks, meeting notes
│   ├── decisions/       architecture decision records (ADRs)
│   ├── risks/           risk register
│   └── meeting-notes/   team and client meeting minutes
├── evidence/            benchmarks, user testing, screenshots, weekly contributions
├── scripts/             create_manager.py, OpenAPI export, benchmark script
├── spec/                requirements, statement of work and team charter, user stories
├── src/
│   ├── frontend/        Next.js app (features/, core/, components/)
│   ├── backend/
│   │   ├── api/         FastAPI routes and schemas, one folder per feature
│   │   ├── common/      shared services, models, scheduling and simulation
│   │   ├── workers/     Celery scheduling tasks
│   │   └── third_party/ ReSched (git submodule)
│   └── database/
│       ├── migrations/  Alembic migrations
│       └── seed-data/   benchmark instances and their solutions
└── tests/
    ├── backend/         unit and API tests
    └── integration/     tests against a real PostgreSQL
```

## Development

```bash
make bootstrap       # once: submodules, uv sync, pnpm install
make check           # formatting, linting, type checks, tests, frontend build, OpenAPI check
make install-hooks   # optional: run make check before every push
```

`make check` needs [uv](https://docs.astral.sh/uv/) and Node.js 22 on the host. CI runs the same
gate on every pull request. [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/pull-requests.md](docs/pull-requests.md) describe how changes are made and reviewed.

## Documentation

- [Specification](spec/README.md): requirements, how they changed, and every user story's final status
- [Deployment and local setup](deployment/README.md)
- [Accounts and signing in](docs/accounts.md)
- [Scheduling](docs/scheduling.md) and [the scheduling and simulation backend](docs/scheduling-simulation-backend.md)
- [Importing production data](docs/importing.md)
- [Database schema](docs/database-schema.md)
- [Decision records](docs/decisions/README.md) and [risk register](docs/risks/README.md)
- [All documentation](docs/README.md)
