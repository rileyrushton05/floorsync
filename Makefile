PNPM := corepack pnpm --dir src/frontend

.PHONY: bootstrap check format-check lint typecheck test frontend-build install-hooks

bootstrap:
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
