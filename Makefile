PNPM := corepack pnpm --dir src/frontend

.PHONY: bootstrap check format-check lint typecheck test test-integration frontend-build install-hooks openapi openapi-check db-upgrade db-revision db-seed db-seed-list

bootstrap:
	git submodule update --init --recursive
	uv sync
	$(PNPM) install --frozen-lockfile

check: format-check lint typecheck test frontend-build openapi-check

format-check:
	uv run ruff format --check .

lint:
	uv run ruff check .
	$(PNPM) lint

typecheck:
	uv run mypy src/backend
	$(PNPM) typecheck

test:
	uv run pytest

# Real-Postgres tests; needs the Compose database up (docker compose up -d postgres).
test-integration:
	uv run pytest tests/integration

# Backend tests with a coverage report: terminal summary saved to evidence/testing/, HTML report in
# htmlcov/. Start Postgres and Redis first (docker compose up -d postgres redis) so the integration
# tests run and do not skip. Needs the exact-solver extra, the same as CI.
coverage:
	mkdir -p evidence/testing
	FLOORSYNC_REQUIRE_TEST_DATABASE=1 uv run --extra exact pytest --cov --cov-report=term --cov-report=html -rs -q | tee evidence/testing/backend-coverage.txt

frontend-build:
	$(PNPM) build

install-hooks:
	git config core.hooksPath .githooks

openapi:
	uv run python scripts/export_openapi.py

openapi-check: openapi
	git diff --exit-code -- docs/openapi.json

db-upgrade:
	docker compose run --rm api alembic upgrade head

db-revision:
	docker compose run --rm api alembic revision --autogenerate -m "$(name)"
	docker compose run --rm api uv run ruff check --fix src/database/migrations/versions
	docker compose run --rm api uv run ruff format src/database/migrations/versions

db-seed:
	docker compose run --rm api python -m floorsync_common.seed $(instance)

db-seed-list:
	docker compose run --rm api python -m floorsync_common.seed --list
