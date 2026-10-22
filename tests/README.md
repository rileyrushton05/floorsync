# Tests

Automated tests for the backend. Results, coverage and the usability evaluation are in
[evidence/](../evidence/README.md).

| Folder | What it holds |
| --- | --- |
| `backend/` | Unit and API tests: scheduling input checks and solver output, simulation, live updates, data import, authentication and every API route. Route tests stub the service layer. |
| `integration/` | Tests against a real PostgreSQL database, for what a fake cannot prove: transactions, row locks, the live-update outbox and relay, recovery after a Redis restart, and imports. |

There are deliberately no automated frontend tests. The rules that matter (validation, scheduling,
the schedule lifecycle and the simulation clock) live in the backend and are tested there, so the
frontend is mostly presentation. It is checked by lint, strict type checks and a production build
on every pull request, and was evaluated through [usability testing](../evidence/user-testing/README.md).

Convention tests in `backend/` also enforce the architecture rules (`test_api_conventions.py`,
`test_database_conventions.py`), for example that no route runs SQL directly.

## Running the tests

Needs [uv](https://docs.astral.sh/uv/) on the host (`make bootstrap` once).

```bash
make test                          # everything; integration tests skip without a database
docker compose up -d postgres redis
make test-integration              # integration tests against the Compose database
make coverage                      # full run with a coverage report in evidence/testing/
```

The integration tests use `FLOORSYNC_TEST_DATABASE_URL`, by default a `floorsync_test` database on
the Compose Postgres (port 5433). They create and migrate it themselves and refuse any database
whose name does not end in `_test`, so the development database is never touched. Set
`FLOORSYNC_REQUIRE_TEST_DATABASE=1` to make them fail instead of skip when no database answers.

## In CI

Every pull request runs the same gate as `make check` in GitHub Actions
(`.github/workflows/ci.yml`): formatting, lint, strict type checks, these tests and an OpenAPI
contract check. When a pull request touches database, live-update, import or simulation code, CI
also starts PostgreSQL and runs the integration tests with `FLOORSYNC_REQUIRE_TEST_DATABASE=1`;
otherwise they skip.

The last full run and its coverage are in [evidence/testing/](../evidence/testing/README.md).
