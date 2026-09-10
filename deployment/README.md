# Deployment

How to set up, run and demonstrate FloorSync. This is the procedure for someone who has the
repository and nothing else — it assumes no verbal explanation from the team.

FloorSync runs as five containers under Docker Compose: a Next.js frontend, a FastAPI API, a Celery
worker, Redis and PostgreSQL. Everything below is local development; there is no hosted deployment
yet (see [Known limitations](#known-limitations)).

## Required software

| Tool | Version | Needed for |
| --- | --- | --- |
| Docker (with Compose v2) | Any current release | Running the stack. This is the only hard requirement. |
| Git | Any current release | Cloning, plus the ReSched submodule. |
| [uv](https://docs.astral.sh/uv/) | Latest | Python tooling on the host: `make check`, tests, linting. |
| Node.js | 22 or later | Frontend tooling on the host. Corepack supplies the pinned pnpm version. |

The containers build their own dependencies from the committed lockfiles (`uv.lock`,
`pnpm-lock.yaml`) with frozen installs, so **uv and Node are not needed just to run the stack**. They
are needed to run the quality gate and the tests outside Docker.

## First run

```bash
git clone <repository-url>
cd team-61-cuffington-and-co

cp .env.example .env          # required: compose reads .env through env_file
make bootstrap                # submodules, uv sync, pnpm install
docker compose up --build -d
make db-upgrade               # apply migrations; startup never creates the schema
```

`make bootstrap` also initialises the ReSched submodule
(`src/backend/third_party/ReSched`), which the worker image copies in. The stack starts without it
and sign-in works fine, but ReSched-backed schedule generation will not.

`cp .env.example .env` is not optional. The `api` and `worker` services declare `env_file: .env`, so
Compose fails outright if the file is absent.

### Load a scenario

An empty database has no jobs and no machines, so most of the app has nothing to show:

```bash
make db-seed-list             # abz5, bel00, ft06, swv11, ta01js
make db-seed instance=abz5
```

**Seed `abz5` if you want to see the simulation.** It is the only instance that currently ships a
solved schedule, so it is the only one that produces a confirmed schedule for
`/manager/simulation` to play. The others load the problem — machines, jobs, operations — and report
`No solution available, so no schedule was created`, which leaves the simulation page on its empty
state.

Seeding **replaces** the current scenario rather than adding to it; the database always holds exactly
one. See [`src/database/seed-data/`](../src/database/seed-data/README.md) for what each instance
contains.

### Create an account

There is no sign-up page — the API has no registration route, so the app cannot be signed into until
an account is made server-side. **[docs/accounts.md](../docs/accounts.md) is the procedure**, and it
covers creating a manager, creating a machine-bound operator, and resetting or disabling either.

A manager account is the minimum needed to sign in and reach `/manager/simulation`.

Create operator accounts **after** seeding. Seeding replaces the machines, and an operator login is
bound to a machine, so reseeding deletes every operator account with the machines they pointed at.
Manager accounts survive seeding.

## What is running

| Service | URL | Host port |
| --- | --- | --- |
| Frontend | <http://localhost:3000> | `3000`, fixed |
| API | <http://localhost:8002> | `API_HOST_PORT`, default `8002` |
| API health | <http://localhost:8002/health> | |
| API documentation | <http://localhost:8002/docs> | |
| WebSocket | `ws://localhost:8002/ws` | |
| PostgreSQL | | `POSTGRES_HOST_PORT`, default `5433` |
| Redis | | `6379`, fixed |

Check the whole stack with `docker compose ps`; `api`, `postgres` and `redis` report a health state,
so `healthy` there means more than "the container started".

## Configuration

`.env` is gitignored and `.env.example` is the committed template. Copying it gives working local
defaults for every variable, so the table below is for when a default does not suit — not a list of
things to fill in.

| Variable | Default | Notes |
| --- | --- | --- |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `floorsync` | Must agree with `DATABASE_URL` and `DATABASE_SYNC_URL`. |
| `POSTGRES_HOST_PORT` | `5433` | Host port only. `5433` avoids a local PostgreSQL already on `5432`. |
| `API_HOST_PORT` | `8002` | Change this **and** `NEXT_PUBLIC_API_URL` together. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8002` | Baked into the browser bundle; it is the browser's view of the API, not the container's. |
| `DATABASE_URL` | asyncpg URL | Used by the API. Hostnames are container names (`postgres`, `redis`), not `localhost`. |
| `DATABASE_SYNC_URL` | psycopg URL | Used by Celery workers and Alembic. |
| `REDIS_URL` / `CELERY_BROKER_URL` | db `0` / db `1` | Result backend and broker. |
| `ENVIRONMENT` | `development` | `production` enables the JWT secret check below. |
| `LOG_LEVEL` / `LOG_FORMAT` | `INFO` / `human` | `json` for machine-readable logs. |
| `JWT_SECRET_KEY` | development placeholder | See [Secrets](#secrets). |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `floorsync-api` / `floorsync-frontend` | Verified on every request; changing one invalidates existing tokens. |
| `JWT_ACCESS_TOKEN_EXPIRE_MINUTES` | `30` | There is no refresh endpoint, so this is the whole session length. |
| `CORS_ALLOWED_ORIGINS` | `["http://localhost:3000"]` | JSON array. Must list the frontend's origin. |
| `ALLOWED_HOSTS` | `["localhost","127.0.0.1","testserver","api"]` | JSON array, enforced by trusted-host middleware. |

## Demonstrating the prototype

With the stack up, `abz5` seeded and a manager account created:

1. Open <http://localhost:3000> and follow a card into the app, or go straight to `/login`.
2. Sign in as the manager. Anonymous visitors to `/manager` or `/operator` are redirected to
   `/login` with `?next=`, so signing in returns them where they were headed.
3. Go to **`/manager/simulation`**. This is the one route that reads from the API — it lists
   schedules from `GET /api/v1/schedules`, then plays the one selected using times the backend
   resolved. Use play/pause, the speed selector (shop-minutes per real second) and the scrubber.
4. Lane labels come from the database, so a seeded benchmark reads `abz5/J03` and `abz5/M07`.

`/manager/jobs`, `/manager/scheduler`, `/manager` and `/operator` still run on in-browser fixtures
and do not read the API — see the [frontend README](../src/frontend/README.md) for exactly which.

To show authorization rather than the UI, sign in as an operator and request a manager-only route:
`GET /api/v1/schedules` answers `403`, and the simulation page reports that plainly instead of a raw
error. [docs/accounts.md](../docs/accounts.md#verify-an-account) has the curl commands.

## Running tests

```bash
make check
```

That is the full gate: Ruff formatting and linting, mypy strict over `src/backend`, pytest, then
frontend linting, type checking and a production build. It runs on the host, so it needs `make
bootstrap` first.

`make install-hooks` runs the same suite before every push. Use `git push --no-verify` only when a
failure is understood and noted in the PR.

## Troubleshooting

**`address already in use` on port 3000.** The frontend's host port is hardcoded in
`docker-compose.yml`, unlike the API and PostgreSQL ports. Something else is on `3000` — most often a
`pnpm dev` server left running from frontend work. Stop it (`ss -ltnp | grep :3000` to find it), or
edit the `frontend` service's port mapping. The same applies to Redis on `6379` if a local Redis is
running.

**`address already in use` on 5432 or 8002.** These are configurable: set `POSTGRES_HOST_PORT` or
`API_HOST_PORT` in `.env`. If you change the API port, change `NEXT_PUBLIC_API_URL` to match, or the
browser will keep calling the old one.

**The frontend loads but every request fails.** `NEXT_PUBLIC_API_URL` is read by the browser, not the
container, so it must be a URL your machine can reach — `http://localhost:8002`, never
`http://api:8000`. The app distinguishes this from a signed-out session and reports "The API is
unreachable" rather than logging you out.

**`relation "users" does not exist`, or similar.** Migrations have not been applied. Application
startup deliberately never creates or mutates the schema. Run `make db-upgrade`.

**Signed in, but the simulation page is empty.** Either no scenario is seeded, or the seeded one has
no solution. Run `make db-seed instance=abz5`.

**Sign-in returns 401 with a password you are sure of.** The account may be disabled — a disabled
credential is refused with the same message as a wrong password, deliberately. List accounts with the
command in [docs/accounts.md](../docs/accounts.md#list-every-account).

**An operator account vanished.** Reseeding deletes operator logins along with the machines they were
bound to; the seed reports this as `removed N operator login(s)`. Recreate them after seeding.

**Starting over.** `docker compose down -v` removes the containers *and* the `postgres_data` volume,
which destroys the database — every account and every seeded scenario. Afterwards you need
`make db-upgrade`, a reseed, and to recreate accounts. Without `-v` the data survives.

## Secrets

Do not commit passwords, API keys, tokens, private keys or real production configuration. `.env` is
gitignored for this reason; `.env.example` is the committed template and holds only development
placeholders.

`JWT_SECRET_KEY` is the one that matters. The committed value is a development placeholder, and
anyone holding it can forge a token for any account. The API refuses to start with it — or with any
secret shorter than 32 characters — when `ENVIRONMENT=production`. Generate a real one and supply it
through the deployment's secret mechanism:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

## Known limitations

- **No deployed environment is maintained by this repository.** The checked-in
  [`docker-compose.yml`](../docker-compose.yml) remains development-only. A documented production
  configuration is available in [One-Droplet CI and deployment](production.md), but it requires
  real domains, infrastructure credentials and a separately provisioned environment file.
- **No account provisioning interface.** Accounts are created by running Python inside the `api`
  container ([docs/accounts.md](../docs/accounts.md)). There is no registration route, admin screen
  or CLI, and no password policy.
- **No password reset or refresh tokens.** A session is one 30-minute token, and a password reset is
  a manual database edit.
- **Only `abz5` can be simulated.** It is the sole instance with a committed solution.
- **Most of the frontend is not wired to the API.** `/manager/simulation` is the exception.
- **Frontend and Redis host ports are not configurable** without editing `docker-compose.yml`.
- **Seeding is destructive** by design, and takes operator accounts with it.

## Related documents

- [Repository README](../README.md) — the short version of this setup.
- [Accounts and signing in](../docs/accounts.md) — creating and managing logins.
- [Technical foundation](../docs/architecture.md) — services, boundaries and tooling.
- [Seed data](../src/database/seed-data/README.md) — what each benchmark instance contains.
- [One-Droplet CI and deployment](production.md) — production Compose, Jenkins and Caddy setup.
