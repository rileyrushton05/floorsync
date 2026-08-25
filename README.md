# DECO3801 / DECO7381 Team Project Repository

This repository is the working space for your DECO3801 / DECO7381 team project.

Your team should use this repository to store your prototype code, design artefacts, documentation, project evidence, testing materials, deployment notes, and other relevant project work.

This repository is also part of your project evidence. Teaching staff will use it to review team progress, project quality, decision-making, and individual contributions throughout the semester.

Teams must keep the major folders for specification, design, documentation, evidence, source code, testing, and deployment. Teams may adapt the internal source-code structure to suit their project architecture.

---

## Repository Structure

```text
project/
├── deployment/
│   └── README.md
├── design/
│   └── README.md
├── docs/
│   ├── meeting-notes/
│   ├── decisions/
│   └── risks/
├── evidence/
│   ├── weekly-contribution/
│   ├── user-testing/
│   └── screenshots/
├── spec/
│   ├── requirements.md
│   ├── statement-of-work.md
│   └── user-stories.md
├── src/
│   ├── frontend/
│   ├── backend/
│   └── database/
│       ├── schema/
│       ├── migrations/
│       └── seed-data/
└── tests/
    ├── frontend/
    ├── backend/
    └── integration/
```

---

## Getting Started

### FloorSync local foundation

This project uses a small service layout that mirrors the planned system: Next.js frontend, FastAPI API, Redis-backed Celery workers and PostgreSQL. Database migrations are owned by the database workstream under `src/database/`; shared SQLAlchemy models and session infrastructure live in `src/backend/common/` so both the API and workers can use them.

Prerequisites: Docker Desktop, [uv](https://docs.astral.sh/uv/), and Node.js 22 or later (Corepack provides the pinned pnpm version).

```bash
cp .env.example .env
make bootstrap
make install-hooks # optional: run the full check suite before each push
docker compose up --build -d
make db-upgrade
```

Open the frontend at <http://localhost:3000>, API health at <http://localhost:8002/health>, and FastAPI docs at <http://localhost:8002/docs>.
The PostgreSQL and API host ports default to `5433` and `8002`; override
`POSTGRES_HOST_PORT`, `API_HOST_PORT`, and the matching `NEXT_PUBLIC_API_URL` in `.env`
when those ports are unavailable.

Dependencies are managed with `uv` and pnpm. Docker uses committed lockfiles with frozen installs. Run the complete local quality gate before opening a PR:

```bash
make check
```

`make check` runs Python formatting, linting, typing and tests, then frontend linting, type checking and a production build. The optional Git hook installed by `make install-hooks` runs the same suite before every push; use `git push --no-verify` only when a failing check is clearly understood and noted in the PR.

See [the technical foundation](docs/architecture.md) for component boundaries and tooling decisions.

This repository has already been created for your team, with all team members and teaching staff added.

Use this repository for all of your team's project work. Update this `README.md` to match your project, and start using issues, branches, commits, pull requests, and GitHub Projects from the beginning of the semester.

Your repository is part of your project evidence. It should show regular progress, not only final submission files.
