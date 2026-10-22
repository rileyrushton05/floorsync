# Source code

The FloorSync prototype. How the parts connect is in the [root README](../README.md#architecture)
and [docs/architecture.md](../docs/architecture.md).

| Folder | What it holds |
| --- | --- |
| [frontend/](frontend/README.md) | Next.js app: `app/` (routes), `features/` (one folder per page area), `core/` (auth, HTTP, live updates, shell), `components/ui/` (Intent UI components) |
| `backend/api/` | FastAPI: one folder per feature under `features/`, each with a `router.py` and `schemas.py`, plus middleware and authorisation dependencies |
| `backend/common/` | Code shared by the API and the worker: database models, services, validation, scheduling engines, simulation, import and live updates. It never imports the API or the worker. |
| `backend/workers/` | Celery tasks that generate schedules with ReSched or Exact |
| `backend/third_party/ReSched/` | The ReSched learned scheduling policy and its trained weights (git submodule) |
| [database/migrations/](database/migrations/README.md) | Alembic migrations |
| [database/schema/](database/schema/README.md) | Where the schema is defined and documented |
| [database/seed-data/](database/seed-data/README.md) | Vendored benchmark instances and their solutions, loaded with `make db-seed` |

The layering rules (routes call services, services own transactions, `common` stays independent)
are in [docs/backend-conventions.md](../docs/backend-conventions.md) and are enforced by tests.

## Third-party code

- **ReSched** ([XiangjieXiao/ReSched](https://github.com/XiangjieXiao/ReSched), MIT): included
  unchanged as a submodule. FloorSync's adapter is `backend/common/floorsync_common/scheduling/resched.py`.
- **Benchmark instances** ([ScheduleOpt/benchmarks](https://github.com/ScheduleOpt/benchmarks),
  CC BY-SA 4.0): copied into `database/seed-data/` with their source recorded there.
- **Intent UI** components ([intentui.com](https://intentui.com)): added to `frontend/components/ui/`
  through its registry.

Every other dependency is a package installed from `pyproject.toml` or `frontend/package.json`.
All external material and AI use are listed in
[docs/external-resources/](../docs/external-resources/README.md).
