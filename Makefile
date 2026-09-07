PNPM := corepack pnpm --dir src/frontend

.PHONY: bootstrap check format-check lint typecheck test frontend-build install-hooks db-upgrade db-revision db-seed db-seed-list

bootstrap:
	git submodule update --init --recursive
	uv sync
	$(PNPM) install --frozen-lockfile

check: format-check lint typecheck test frontend-build

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

frontend-build:
	$(PNPM) build

install-hooks:
	git config core.hooksPath .githooks

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
