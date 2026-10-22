# Deployment

How to set up, run and demonstrate FloorSync. It is written for someone who has the repository and
nothing else, so it assumes no verbal explanation from the team.

FloorSync runs as five containers under Docker Compose: a Next.js frontend, a FastAPI API, a Celery
worker, Redis and PostgreSQL. Everything here is local; this repository has no hosted deployment
(see [Known limitations](#known-limitations)).

## Quick start

With [Docker](https://docs.docker.com/get-docker/) running:

```bash
git clone --recurse-submodules <repository-url>
cd team-61-cuffington-and-co
deployment/run-local.sh
```

Then open <http://localhost:3000> and sign in as `manager` / `floorsync-dev`.

[`run-local.sh`](run-local.sh) does every setup step in [Manual setup](#manual-setup): it creates
`.env`, fetches the ReSched submodule, builds and starts the stack, waits until it is healthy, seeds
the `abz5` scenario and creates the manager account. Running it again skips whatever is already
done, so it is also the way to start the stack each day. `deployment/run-local.sh kacem1` seeds a
different scenario on the first run.

The first build takes several minutes, because the worker image installs PyTorch, OR-Tools and
Gurobi's Python package.

**It worked if** the script ends with "FloorSync is running" and `docker compose ps` shows `api`,
`postgres` and `redis` as `healthy`.

On Windows, run the script from Git Bash or WSL, or follow [Manual setup](#manual-setup), which
gives a plain `docker compose` command for every step.

## Deployment files

| What | File | Purpose |
| --- | --- | --- |
| Deployment manifest | [`docker-compose.yml`](../docker-compose.yml) | Defines the five services, their ports, health checks, start order and the `postgres_data` volume. |
| Container configuration | [`src/frontend/Dockerfile`](../src/frontend/Dockerfile) | Node 22 image; installs the frontend from `pnpm-lock.yaml` and runs Next.js on port 3000. |
| Container configuration | [`src/backend/api/Dockerfile`](../src/backend/api/Dockerfile) | Python 3.12 image; installs the API from `uv.lock` and serves FastAPI on port 8000. Compose runs migrations before starting it. |
| Container configuration | [`src/backend/workers/Dockerfile`](../src/backend/workers/Dockerfile) | Python 3.12 image with the `resched` and `exact` extras (PyTorch, Gurobi, OR-Tools) and the ReSched model; runs the Celery `scheduling` queue. |
| Environment template | [`.env.example`](../.env.example) | Every setting with a working local default; copied to `.env`. See [Configuration](#configuration). |
| Local execution script | [`run-local.sh`](run-local.sh) | One-command setup and start (above). |
| Local execution scripts | [`Makefile`](../Makefile) | `db-seed`, `db-seed-list`, `db-upgrade`, `check`, `test-integration` and the other day-to-day commands. |
| Local execution script | [`scripts/create_manager.py`](../scripts/create_manager.py) | Creates the first manager account. |

The manifest, Dockerfiles and environment template stay where Docker expects them: Compose reads
`docker-compose.yml` and `.env` from the repository root, and the Dockerfiles copy paths relative to
the build contexts it sets (the repository root for the API and worker, `src/frontend` for the
frontend). Moving them here would break `docker compose up`, the CI workflow and these links.

## Required software

| Tool | Version | Needed for |
| --- | --- | --- |
| Docker (with Compose v2.1 or later) | Any current release | Running the stack. This is the only hard requirement. |
| Git | Any current release | Cloning, plus the ReSched submodule. |
| [uv](https://docs.astral.sh/uv/) | Latest | Python tooling on the host: `make check`, tests, linting. |
| Node.js | 22 or later | Frontend tooling on the host. Corepack supplies the pinned pnpm version. |
| Gurobi licence | Optional | The **Exact** scheduling strategy only. See [Exact solver licence](#exact-solver-licence). |

The images install their own dependencies from the committed lockfiles, so **uv and Node are not
needed just to run the stack**. They are needed for the quality gate and the tests outside Docker.

## Manual setup

These are the steps `run-local.sh` automates. Each `make` command has its plain `docker compose`
equivalent beside it, for machines without `make`.

### 1. Configure and start

```bash
cp .env.example .env                        # Windows: copy .env.example .env
git submodule update --init --recursive     # or: make bootstrap (also installs host tooling)
docker compose up --build -d --wait
```

- `.env` is required. The `api` and `worker` services declare `env_file: .env`, so Compose fails
  outright without it.
- The submodule is ReSched (`src/backend/third_party/ReSched`). Without it the stack still starts
  and sign-in works, but ReSched schedule generation does not. A copy of the repository without git
  history (a ZIP download) has an empty folder here: clone
  <https://github.com/XiangjieXiao/ReSched> into it at commit
  `5f00020c692ab03120922bdb3b969090e3f79d3c`.
- The API applies any outstanding database migrations before it starts serving, and the worker
  waits for the API's health check. `--wait` returns once everything is up.

### 2. Load a scenario

An empty database has no jobs and no machines, so most pages have nothing to show.

| `make` | Plain `docker compose` |
| --- | --- |
| `make db-seed-list` | `docker compose run --rm api python -m floorsync_common.seed --list` |
| `make db-seed instance=abz5` | `docker compose run --rm api python -m floorsync_common.seed abz5` |

| Family | Instances | Ships a solved schedule |
| --- | --- | --- |
| Job shop (one machine per operation) | `abz5`, `bel00`, `ft06`, `swv11`, `ta01js` | `abz5` only |
| Flexible job shop (several machines per operation) | `behnke58`, `dafjs01`, `fattahi1`, `kacem1` | All four |

- **Seed `abz5` for the demo.** It has 10 jobs on 10 machines, and its solved schedule is loaded as
  a confirmed schedule, so the Simulation page has something to play straight away.
- Instances without a solution load the problem only and report
  `No solution available, so no schedule was created`. Generate one from the Planner instead.
- `dafjs01` has operations that wait on several others (fan-in). Only the Exact strategy can
  schedule it.
- Seeding **replaces** the current scenario rather than adding to it, so the database always holds
  exactly one. It also replaces the operator logins (see below).

[`src/database/seed-data/`](../src/database/seed-data/README.md) describes each instance, its source
and its licence.

### 3. Create a manager account

There is no sign-up page, so the first manager is created from the command line:

```bash
docker compose run --rm api python scripts/create_manager.py
```

That creates username `manager`, password `floorsync-dev`. Edit the constants at the top of
[`scripts/create_manager.py`](../scripts/create_manager.py) for a different name or password. Running
it a second time fails with `duplicate key value violates unique constraint
"uq_user_credentials_username"`, which means the account already exists. Manager accounts survive
reseeding.

### Operator accounts

Operator accounts are created automatically: **every machine gets one login**, whether it was seeded,
imported or added on the Machines page.

- The username is the machine name as a lowercase slug: `abz5/M0` becomes `abz5-m0`.
- The password is `OPERATOR_DEFAULT_PASSWORD` from `.env` (default `floorsync-dev`).
- A manager can rename, reset or disable them under **Settings > Operator accounts**.
- Reseeding removes the old machines' logins and creates new ones; the seed output says how many.

[docs/accounts.md](../docs/accounts.md) covers listing, resetting and disabling accounts.

## What is running

| Service | URL | Host port |
| --- | --- | --- |
| Frontend | <http://localhost:3000> | `3000`, fixed |
| API | <http://localhost:8002> | `API_HOST_PORT`, default `8002` |
| API documentation | <http://localhost:8002/docs> | |
| Health | <http://localhost:8002/health>, `/health/live`, `/health/ready` | |
| WebSocket (live updates) | `ws://localhost:8002/ws` | |
| PostgreSQL | `localhost:5433`, user, password and database all `floorsync` | `POSTGRES_HOST_PORT`, default `5433` |
| Redis | | `6379`, fixed |

`docker compose ps` shows the whole stack. `api`, `postgres` and `redis` report a health state, so
`healthy` there means more than "the container started". The worker has no health check; check it
with `docker compose logs worker`. Any PostgreSQL client (TablePlus, DBeaver, `psql`) can open the
database with the details above.

Stop the stack with `docker compose stop`; the data is kept for next time.

## Demonstrating the prototype

With the stack up, `abz5` seeded and the manager account created:

1. **Sign in.** Open <http://localhost:3000/login> and sign in as `manager` / `floorsync-dev`.
   Visiting `/manager` or `/operator` while signed out redirects to the login page and back.
2. **Simulate.** Go to **Scheduling > Simulation**, pick the confirmed `abz5` schedule and press
   play. Use the speed selector and the scrubber; the Gantt chart, machine states and job progress
   move with the simulated clock.
3. **Monitor.** Open **Overview** while the simulation runs. It follows the same clock: which
   machines are active or idle and how far each job has got. Everyone watching sees the same
   simulated time.
4. **Operator view.** In a private window, sign in as `abz5-m0` / `floorsync-dev`. The operator page
   shows that machine's current operation, its queue, expected times and upcoming breaks.
5. **Add work.** Go to **Resources > Import** and drop in
   [`docs/examples/import-example.json`](../docs/examples/import-example.json). The preview lists what
   it would add and any problems; press Import. Jobs can also be built by hand under **Resources >
   Jobs**.
6. **Plan.** Go to **Scheduling > Planner**, tick the open jobs, choose a strategy and press Generate.
   Review the makespan and machine load, then **Save schedule** to name and confirm it (or **Save as
   draft** to confirm it later from **Scheduling > Schedules**). A confirmed schedule appears on the
   Simulation page.

The import example includes a fan-in job ("Laminated door panel"), so ReSched refuses a selection
that contains it. Leave that job unticked, or use Exact with a licence.

To show authorization rather than the UI: signed in as an operator, `GET /api/v1/schedules` answers
`403`. [docs/accounts.md](../docs/accounts.md#verify-an-account) has the curl commands, and
<http://localhost:8002/docs> can do the same through **Authorize**.

## Exact solver licence

The Planner offers two scheduling strategies:

| Strategy | What it is | Needs |
| --- | --- | --- |
| **ReSched** (default) | A pretrained learned dispatching policy. Fast and approximate. | Nothing extra. |
| **Exact** | Logic-based Benders decomposition: a Gurobi master problem with OR-Tools CP-SAT subproblems. Better makespans, up to 120 seconds per run. | A Gurobi licence. |

ReSched refuses selections with fan-in or fan-out (an operation with several predecessors or
successors), and the Planner says so before generating. Exact takes any precedence graph.

To enable Exact:

1. Get a Gurobi licence that works inside a container, such as a free academic
   [Web License Service (WLS)](https://www.gurobi.com/academia/academic-program-and-licenses/)
   licence. A named-user academic licence is tied to one host and is rejected inside Docker.
2. Save the licence file at the repository root as `gurobi.lic`. It is gitignored; never commit it.
   The worker finds it through `GRB_LICENSE_FILE=/app/gurobi.lic`, set in `docker-compose.yml`.
3. Restart the worker: `docker compose up -d worker`.

Without a licence, Exact runs are accepted but the Planner reports "The scheduling engine is
unavailable". ReSched is unaffected either way.

## Running tests

```bash
make bootstrap                # once: submodules, uv sync, pnpm install
make check
```

`make check` is the full gate: Ruff formatting and linting, mypy strict over `src/backend`, pytest,
frontend linting (including the architecture check), type checking, a production build, and a check
that [`docs/openapi.json`](../docs/openapi.json) matches the API.

The integration tests in `tests/integration/` run against a real PostgreSQL. With the Compose
database up (`docker compose up -d postgres`), `make test-integration` runs them against a separate
`floorsync_test` database on port 5433, never the dev one. `make check` includes them, and skips them
when no database is reachable.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs the same gate on every pull
request, plus the integration tests when database code changes. `make install-hooks` runs
`make check` before every push.

## Troubleshooting

**`address already in use` on port 3000 or 6379.** The frontend and Redis host ports are fixed in
`docker-compose.yml`. Something else is using them, most often a `pnpm dev` server or a local Redis.
Find it with `lsof -i :3000` (macOS), `ss -ltnp | grep :3000` (Linux) or
`netstat -ano | findstr :3000` (Windows) and stop it, or edit the port mapping.

**`address already in use` on 5433 or 8002.** Set `POSTGRES_HOST_PORT` or `API_HOST_PORT` in `.env`.
If you change the API port, change `NEXT_PUBLIC_API_URL` to match, or the browser keeps calling the
old one.

**The frontend loads but every request fails.** `NEXT_PUBLIC_API_URL` is read by the browser, so it
must be a URL your machine can reach: `http://localhost:8002`, never `http://api:8000`. The app
reports "The API is unreachable" rather than signing you out.

**The frontend shows a 500 with `Module not found: Can't resolve ...`.** The frontend's
`node_modules` lives in a Docker volume, which goes stale when dependencies change after a pull.
Refresh it:

```bash
docker compose exec frontend pnpm install --frozen-lockfile
docker compose restart frontend
```

**Generate never finishes, or fails after a pull.** The worker does not reload code, and its Python
dependencies are baked into its image. Rebuild and restart it, then check its log:

```bash
docker compose build worker && docker compose up -d worker
docker compose logs -f worker
```

**Exact always reports "The scheduling engine is unavailable".** There is no usable Gurobi licence.
See [Exact solver licence](#exact-solver-licence).

**`relation "users" does not exist`, or similar.** The API's migrations did not run. Check
`docker compose logs api`, fix the reported error and restart with `docker compose up -d api`, or
run `make db-upgrade` (`docker compose run --rm api alembic upgrade head`).

**Signed in, but the Simulation page is empty.** No confirmed schedule exists. Seed an instance that
ships one (`abz5`), or generate and confirm one in the Planner.

**Sign-in returns 401 with a password you are sure of.** The account may be disabled. A disabled
account gets the same message as a wrong password, deliberately. List accounts with the command in
[docs/accounts.md](../docs/accounts.md#list-every-account).

**An operator login stopped working after reseeding.** Reseeding replaces the machines, and their
logins with them. Sign in with the new machine's username, or check **Settings > Operator accounts**.

**Starting over.** `docker compose down -v` removes the containers *and* the `postgres_data`
volume, which deletes the database: every account and every scenario. Then run
`deployment/run-local.sh` again. Without `-v` the data survives.

## Configuration

`.env` is gitignored and `.env.example` is the committed template. Copying it gives working local
defaults for every variable, so this table is for when a default does not suit, not a list of things
to fill in.

| Variable | Default | Notes |
| --- | --- | --- |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `floorsync` | Must agree with `DATABASE_URL` and `DATABASE_SYNC_URL`. |
| `POSTGRES_HOST_PORT` | `5433` | Host port only. `5433` avoids a local PostgreSQL already on `5432`. |
| `API_HOST_PORT` | `8002` | Change this **and** `NEXT_PUBLIC_API_URL` together. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8002` | The browser's view of the API, not the container's. |
| `DATABASE_URL` | asyncpg URL | Used by the API. Hostnames are service names (`postgres`, `redis`), not `localhost`. |
| `DATABASE_SYNC_URL` | psycopg URL | Used by the Celery worker and Alembic. |
| `REDIS_URL` / `CELERY_BROKER_URL` | db `0` / db `1` | Result backend and live updates / task broker. |
| `LIVE_UPDATE_CHANNEL_PREFIX` | `floorsync.live` | Prefix of the live-update pub/sub channel; change it if environments share one Redis. |
| `REDIS_SOCKET_TIMEOUT_SECONDS` | `2` | Connect and command timeout for live-update Redis calls, so a hanging Redis cannot hang the API. |
| `ENVIRONMENT` | `development` | `production` enables the JWT secret check in [Secrets](#secrets). |
| `LOG_LEVEL` / `LOG_FORMAT` | `INFO` / `human` | `json` for machine-readable logs. |
| `MAX_REQUEST_BODY_BYTES` | `1048576` (1 MiB) | Largest request the API accepts, including import uploads. |
| `JWT_SECRET_KEY` | development placeholder | See [Secrets](#secrets). |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `floorsync-api` / `floorsync-frontend` | Verified on every request; changing one invalidates existing tokens. |
| `JWT_ACCESS_TOKEN_EXPIRE_MINUTES` | `30` | There is no refresh endpoint, so this is the whole session length. |
| `CORS_ALLOWED_ORIGINS` | `["http://localhost:3000"]` | JSON array. Must list the frontend's origin. |
| `ALLOWED_HOSTS` | `["localhost","127.0.0.1","testserver","api"]` | JSON array, enforced by trusted-host middleware. |
| `OPERATOR_DEFAULT_PASSWORD` | `floorsync-dev` | Starting password for every operator login created with a machine. |

## Secrets

Never commit passwords, API keys, tokens, private keys, `gurobi.lic` or real production
configuration. `.env` is gitignored for this reason; `.env.example` holds only development
placeholders.

`JWT_SECRET_KEY` matters most. The committed value is a development placeholder, and anyone holding
it can forge a token for any account. With `ENVIRONMENT=production`, the API refuses to start with
it, or with any secret shorter than 32 characters. Generate a real one and supply it through the
deployment's secret mechanism:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

## Known limitations

- **No hosted deployment.** [`docker-compose.yml`](../docker-compose.yml) is for local development
  only. Production infrastructure, credentials and configuration must be supplied separately.
- **The containers run in development mode.** The frontend image runs the Next.js dev server
  (`pnpm dev`), not a production build, and Compose runs the API with auto-reload and the source
  mounted in. Pages compile on first visit, so the first load of each is slower.
- **Manager accounts are created from the command line.** There is no sign-up page or manager
  admin screen, and a manager's password is reset by editing the database
  ([docs/accounts.md](../docs/accounts.md)). Operator accounts are managed in Settings.
- **No refresh tokens.** A session is one 30-minute token.
- **Exact needs a Gurobi licence**, which this repository cannot ship.
- **ReSched refuses fan-in and fan-out**, so jobs shaped that way need Exact.
- **Machine downtime is not supported.** The `unavailabilities` table exists, but it has no API, and
  both strategies refuse a selection whose machines have downtime.
- **Operator completions are local.** "Mark complete" on the operator page is kept in that browser
  only: it is not saved, not shared with the manager, and resets on refresh.
- **Frontend and Redis host ports are fixed** unless `docker-compose.yml` is edited.
- **Seeding is destructive** by design, and replaces operator logins with the machines.

## Related documents

- [Repository README](../README.md): project overview and repository map.
- [Accounts and signing in](../docs/accounts.md): creating and managing logins.
- [Importing production data](../docs/importing.md): the import file format and endpoint.
- [Scheduling](../docs/scheduling.md): the scheduling strategies.
- [Technical foundation](../docs/architecture.md): services, boundaries and tooling.
- [Seed data](../src/database/seed-data/README.md): what each benchmark instance contains.
