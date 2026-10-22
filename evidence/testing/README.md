# Technical testing evidence

How the backend is tested, what the last run showed, and where to find the evidence.

## What is tested

The backend has 829 automated tests in `tests/backend/` and `tests/integration/`. Every pull request runs them in GitHub Actions (`.github/workflows/ci.yml`) together with lint, strict type checks and an OpenAPI contract check. When a PR touches database, live-update or simulation code, CI also starts a real PostgreSQL container and runs the integration tests against it.

| Area | Where | What it checks |
|---|---|---|
| Schedule validity | `test_scheduling_validation.py`, `test_seed_solutions.py`, `test_gurobi_exact_solver.py`, `test_fjsp_lbbd.py` | Input checks reject bad problems, and solver output respects precedence, compatible machines and machine overlap |
| Simulation | `test_simulation.py`, `test_simulation_api.py` | Clock, pause, resume, speed, seek and reset |
| Live updates | `test_live_update_*.py`, `tests/integration/test_live_update_*.py` | Tickets, websocket protocol, rate limits, outbox delivery, relay, and recovery after a Redis restart, against real Postgres and Redis |
| Data import | `test_import_*.py`, `tests/integration/test_data_import.py` | File formats, validation and persistence |
| API behaviour | `test_*_api.py`, `test_auth.py` | Jobs, machines, operations, schedules, operators, roles |

There are no automated frontend tests. `tests/frontend/` is empty and the frontend CI job only runs lint, type checks and a build. Frontend changes are covered by usability testing instead (see `traceability.md`).

## Last run

See `backend-coverage.txt` for the full output, including the date, commit and command.

- **Result:** 828 passed, 1 skipped, 0 failed (the skip is the ReSched runtime test, because ReSched's optional dependencies are not installed on the machine used).
- **Coverage:** 84% of statements and branches across `src/backend` (7,687 statements). The database and live-update integration tests ran against Compose Postgres and Redis and did not skip.
- **Strongest areas:** data import (98%), database models (97%), live updates (96%), simulation (92%), schedules (90%).
- **Weakest areas:** the superseded `FJSP_benders.py` (17%, replaced by CP-LBBD), machines (78%), jobs (81%), operations (82%), and `resched.py` (37%, because its runtime is not installed). The remaining gaps are mostly error paths in the routers and services.

## Re-running

```bash
docker compose up -d postgres redis
make coverage
```

This rewrites `backend-coverage.txt` and writes an HTML report to `htmlcov/` (not committed).
