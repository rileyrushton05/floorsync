#!/usr/bin/env bash
# Start FloorSync locally in one command. Safe to run again: each step is skipped once done.
#
#   deployment/run-local.sh            # first run seeds abz5
#   deployment/run-local.sh kacem1     # first run seeds kacem1 instead
#
# The scenario is only seeded into an empty database. To switch scenarios later, use
# `make db-seed instance=<name>`, which replaces the current one.
set -euo pipefail

cd "$(dirname "$0")/.."
instance="${1:-abz5}"
resched_dir="src/backend/third_party/ReSched"
resched_commit="5f00020c692ab03120922bdb3b969090e3f79d3c"

if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example"
fi

if [ -d .git ]; then
    git submodule update --init --recursive
fi
if [ -z "$(ls -A "$resched_dir" 2>/dev/null)" ]; then
    echo "Warning: $resched_dir is empty, so ReSched schedule generation will not work."
    echo "  Clone https://github.com/XiangjieXiao/ReSched into it at commit $resched_commit."
fi

docker compose up --build -d --wait

# Runs inside the postgres container, so it uses that container's database name and user.
query() {
    docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\""
}

if [ "$(query 'select count(*) from machines')" = "0" ]; then
    docker compose run --rm api python -m floorsync_common.seed "$instance"
else
    echo "Database already holds a scenario; not seeding."
fi

if [ "$(query "select count(*) from users where role = 'manager'")" = "0" ]; then
    docker compose run --rm api python scripts/create_manager.py
else
    echo "A manager account already exists; not creating one."
fi

if [ ! -f gurobi.lic ]; then
    echo "No gurobi.lic at the repository root: the Exact strategy is unavailable, ReSched works."
fi

cat <<'EOF'

FloorSync is running.
  App       http://localhost:3000   manager / floorsync-dev
  Operator  machine name as a slug, e.g. abz5-m0 / floorsync-dev
  API docs  http://localhost:8002/docs
  Stop      docker compose stop
EOF
