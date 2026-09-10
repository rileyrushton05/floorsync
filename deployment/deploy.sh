#!/usr/bin/env bash
# This script is intended to run on the production Droplet as the `deploy` user.
# Jenkins invokes it through a forced-command SSH key; it never receives Docker
# socket access or the production environment file directly.

set -euo pipefail

readonly project_dir="/opt/floorsync"
readonly compose_file="deployment/docker-compose.production.yml"
readonly environment_file=".env.production"

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
    read -r command commit extra <<<"${SSH_ORIGINAL_COMMAND}"
    if [[ "${command}" != "deploy" || -n "${extra:-}" ]]; then
        echo "Expected: deploy <40-character commit SHA>" >&2
        exit 64
    fi
else
    command="${1:-}"
    commit="${2:-}"
    if [[ "${command}" != "deploy" || -n "${3:-}" ]]; then
        echo "Usage: $0 deploy <40-character commit SHA>" >&2
        exit 64
    fi
fi

if [[ ! "${commit}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Commit must be a 40-character lowercase SHA" >&2
    exit 64
fi

cd "${project_dir}"

if [[ ! -f "${environment_file}" ]]; then
    echo "Missing ${project_dir}/${environment_file}" >&2
    exit 78
fi

git fetch --quiet origin
git cat-file -e "${commit}^{commit}"
git checkout --quiet --detach "${commit}"
git submodule update --init --recursive

docker compose --env-file "${environment_file}" -f "${compose_file}" build --pull
docker compose --env-file "${environment_file}" -f "${compose_file}" up -d postgres redis
docker compose --env-file "${environment_file}" -f "${compose_file}" run --rm api alembic upgrade head
docker compose --env-file "${environment_file}" -f "${compose_file}" up -d --remove-orphans

for attempt in {1..10}; do
    if curl --fail --silent --show-error http://127.0.0.1:8000/health/ready; then
        echo
        echo "Deployment of ${commit} is ready."
        exit 0
    fi
    sleep 3
done

echo "Deployment of ${commit} did not become ready" >&2
exit 1
