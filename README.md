# FloorSync

Flexible job shop scheduling, simulation and live operations management. Built over 12 weeks
(August to October 2026) by a team of six for the University of Queensland course DECO3801, project
13, with an industry client.

A production manager selects jobs and generates a schedule that assigns every operation to a
compatible machine with start and end times. The schedule then plays out in a time-driven
simulation, while the manager watches every machine and job on a live overview and each operator
follows their own machine's queue.

## My contributions (Riley Rushton)

I owned the domain models and data: the database, the data APIs, the schedule lifecycle and file
import. Pull request numbers refer to the original course repository, which is private.

- **Database schema and migrations:** designed the relational model for jobs, operations, machine
  compatibilities, dependencies, schedules and simulations, with Alembic migrations (#201, #239),
  including a forward-only fix for schema drift between upgraded and fresh databases (#252).
- **Benchmark seeding:** loaded classic and flexible job shop instances from ScheduleOpt, with their
  pre-solved schedules, so the simulation had realistic data from the start (#205, #213).
- **Data APIs:** machines, capabilities, categories, jobs, operations and their ordering, with cycle
  detection and cursor pagination (#215, #232, #309, #324).
- **Schedule lifecycle:** scheduling a chosen set of jobs, validating data before generation,
  confirming and discarding schedules, archiving finished jobs and deriving each job's backlog
  status (#257, #261, #262, #267, #272, #273, #313).
- **Live-update outbox:** recorded simulation changes in a transactional outbox, with integration
  tests against real PostgreSQL and a CI gate that runs them when database code changes (#288,
  #289, #291).
- **File import:** `POST /api/v1/imports` reads FloorSync JSON or benchmark files, reports every
  problem at once with a dry run, and writes everything in one transaction, safe under concurrent
  imports (#300).
- **Code review:** reviewed 42 of the team's merged pull requests, running each against a real
  database.

## Links

| What | Where |
| --- | --- |
| Deployment | None hosted: FloorSync runs locally with Docker Compose ([why](spec/requirements/requirement-changes.md), CHG-10) |
| Benchmark instances | [ScheduleOpt benchmarks](https://github.com/ScheduleOpt/benchmarks), vendored in [src/database/seed-data/](src/database/seed-data/README.md) |
| ReSched (baseline scheduler) | [XiangjieXiao/ReSched](https://github.com/XiangjieXiao/ReSched), included as a git submodule |
| Gurobi academic licence (optional, for the Exact strategy) | <https://www.gurobi.com/academia/academic-program-and-licenses/> |

## Getting started

You need [Git](https://git-scm.com/downloads) and [Docker Desktop](https://docs.docker.com/get-docker/)
(or Docker Engine with Compose v2.1 or later), running. On Windows, use WSL or Git Bash for the
script.

```bash
git clone --recurse-submodules https://github.com/rileyrushton05/floorsync.git
cd floorsync
deployment/run-local.sh
```

The script creates `.env`, runs `docker compose up --build -d --wait`, seeds a benchmark scenario
and creates a manager account. Everything else (Python and Node packages, PostgreSQL and Redis
images, the ReSched model weights) is downloaded during the first build, which takes several
minutes. Later runs start in seconds.

Then open <http://localhost:3000> and sign in as `manager` / `floorsync-dev`. Operators sign in
with their machine's name, for example `abz5-m0` / `floorsync-dev`. The API documentation is at
<http://localhost:8002/docs>.

Without the script, the same steps by hand:

```bash
cp .env.example .env
docker compose up --build -d --wait
docker compose run --rm api python -m floorsync_common.seed abz5
docker compose run --rm api python scripts/create_manager.py
```

Stop with `docker compose stop`. The Exact strategy also needs a Gurobi licence file
(`gurobi.lic`) in the repository root; without one, ReSched still works.
[deployment/README.md](deployment/README.md) is the full guide: the deployment files, a demo
walkthrough, the licence, configuration, troubleshooting and known limitations.

## Architecture

Containers (C4 level 2):

![FloorSync system architecture](docs/diagrams/architecture/system-architecture.png)

Inside the FastAPI application (C4 level 3):

![FloorSync backend components](docs/diagrams/architecture/backend-components.png)

| Container | Technology | Role |
| --- | --- | --- |
| Frontend | Next.js, React, TypeScript, TanStack Query | Manager and operator pages in the browser |
| API | FastAPI, SQLAlchemy (async), Alembic | REST API, WebSocket live updates, simulation clock, outbox relay |
| Worker | Celery | Generates schedules with ReSched (learned policy) or Exact (Gurobi with OR-Tools CP-SAT) |
| PostgreSQL | PostgreSQL 16 | Production data, schedules, simulations, accounts, live-update outbox |
| Redis | Redis 7 | Celery broker, live-update publish and subscribe, one-time WebSocket tickets |

How a schedule moves through the system, from the brief's pipeline:

```mermaid
flowchart LR
    data["Jobs, machines<br/>(entered or imported)"] --> validate["Validate"]
    validate --> generate["Generate on the worker<br/>(ReSched or Exact)"]
    generate --> draft["Draft schedule"]
    draft --> confirm["Confirm"]
    confirm --> simulate["Simulate<br/>(one shared clock)"]
    simulate --> manager["Manager overview"]
    simulate --> operator["Operator view<br/>(one per machine)"]
```

Every diagram, including the outbox and playback patterns, the ERDs and the runtime sequences, is
in the [diagram catalogue](docs/diagrams/README.md) with its editable source. The database schema is
in [docs/database-schema.md](docs/database-schema.md), [docs/architecture.md](docs/architecture.md)
covers code boundaries, and the [decision records](docs/decisions/README.md) explain the main
choices.

## Credits

**Developed by the team**

- **Frontend:** the sign-in page and every manager and operator page (Overview, Jobs, Import, Planner, Schedules,
  Simulation, Machines, Settings, Operator), the schedule timeline, the job dependency graph and the
  live-update client.
- **Backend API:** every FastAPI feature (auth, machines, jobs and operations, schedules,
  simulation, import, operator accounts, live updates) and the service layer behind them.
- **Database:** the schema, all Alembic migrations, and the seed loader that reads the benchmark
  formats.
- **Scheduling:** input validation, the adapter that runs ReSched on FloorSync data, and the Exact
  strategy. Exact is our implementation of critical-path logic-based Benders decomposition from
  Naderi and Roshanaei (2022), with deliberate deviations listed at the top of
  [FJSP_lbbd.py](src/backend/common/floorsync_common/scheduling/FJSP_lbbd.py). The first Exact
  solver, a Gurobi MILP, followed the Dauzère-Pérès et al. formulation ([ADR 0014](docs/decisions/0014-fajsp_milp_formulation.md)).
- **Simulation and live updates:** the server-side simulation clock, the transactional outbox,
  the Redis relay and the WebSocket delivery with one-time tickets.
- **File import:** the FloorSync JSON format, the benchmark-format readers and the dry run.
- **Engineering and evaluation:** the automated tests, CI, Docker set-up, documentation, the
  benchmark comparison and the usability study.

**Used unchanged from existing sources**

- **ReSched** learned scheduling policy and trained weights ([XiangjieXiao/ReSched](https://github.com/XiangjieXiao/ReSched), MIT):
  the fast strategy and the evaluation baseline, called through our adapter.
- **Benchmark instances and best known results** ([ScheduleOpt/benchmarks](https://github.com/ScheduleOpt/benchmarks), CC BY-SA 4.0):
  the seed scenarios, import formats and evaluation data.

**Adapted from existing sources**

- **Intent UI** components ([intentui.com](https://intentui.com), MIT): buttons, fields, dialogs and
  other parts in `src/frontend/components/ui/`, added from its registry and then edited.

**Existing tools and libraries**

Next.js, React, TypeScript, TanStack Query, React Aria and Tailwind CSS on the frontend; FastAPI,
SQLAlchemy, Alembic, Pydantic and Celery on the backend; PostgreSQL and Redis for storage and
messaging; Gurobi and OR-Tools CP-SAT inside the Exact strategy; PyTorch and NumPy to run ReSched.
Every dependency and its licence is in [docs/external-resources/](docs/external-resources/README.md).

**AI tools**

Claude Code (five members) and Codex (one member) were used to explain concepts, weigh design
options, debug, and help implement small parts of features step by step. They also generated code:
mostly boilerplate, and close variations of a pattern after a member had implemented the first
instance themselves. Every change was reviewed, tested and committed by a team member.

## Repository map

```text
.
├── deployment/          setup guide and run-local.sh
├── design/              inspiration, wireframes and UI evolution
├── docs/                architecture, conventions, decisions, risks
│   ├── decisions/       architecture decision records (ADRs)
│   ├── diagrams/        architecture, pattern, data and sequence diagrams
│   └── risks/           risk register
├── evidence/            evaluation evidence
│   ├── benchmarks/      ReSched against Exact results and charts
│   ├── testing/         backend test and coverage evidence
│   └── traceability.md  testing findings traced to fixes and tests
├── scripts/             create_manager.py, OpenAPI export, benchmark script
├── spec/                requirements and user stories
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

## Documentation and evidence

- [System diagrams](docs/diagrams/README.md): architecture, components, outbox and playback patterns, ERDs and runtime sequences
- [Specification](spec/README.md): requirements, success criteria, changes and user stories
- [Design](design/README.md): inspiration, wireframes and how the UI evolved
- [Scheduling](docs/scheduling.md) and [the scheduling and simulation backend](docs/scheduling-simulation-backend.md)
- [Importing production data](docs/importing.md) and [accounts and signing in](docs/accounts.md)
- [Decision records](docs/decisions/README.md) and the [risk register](docs/risks/README.md)
- [Evaluation results](evidence/README.md): benchmarks, testing, usability and [traceability](evidence/traceability.md)
- [All documentation](docs/README.md)

## Team

| Member | GitHub | Responsibility |
| --- | --- | --- |
| Riley Rushton | [rileyrushton05](https://github.com/rileyrushton05) | Domain models and data: schema, migrations, seeding, data APIs, import, schedule lifecycle |
| Jason Zhong | [jzhong00](https://github.com/jzhong00) | System foundations: scaffold, conventions, authentication, CI, frontend architecture |
| Ben Cuffe | [Wugene1](https://github.com/Wugene1) | Scheduling engine: the Exact solver and the benchmark evaluation |
| Beth McMeechan | [bethmcm16](https://github.com/bethmcm16) | Production simulation: simulation engine, live updates, usability testing |
| Xavier Alderson | [xjalder](https://github.com/xjalder) | Frontend interfaces: dashboards, planner, simulation playback, settings |
| Jayden Phan | [jjjeidennn](https://github.com/jjjeidennn) | Frontend interfaces: manager pages, UI polish, design |
