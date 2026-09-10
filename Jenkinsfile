pipeline {
  agent { label 'docker' }

  options {
    timestamps()
    timeout(time: 20, unit: 'MINUTES')
    disableConcurrentBuilds()
  }

  stages {
    stage('Backend quality') {
      agent {
        docker {
          image 'ghcr.io/astral-sh/uv:0.12.5-python3.12-bookworm'
          reuseNode true
        }
      }
      steps {
        sh 'uv sync --frozen --group dev'
        sh 'uv run ruff format --check .'
        sh 'uv run ruff check .'
        sh 'uv run mypy src/backend'
        sh 'mkdir -p reports && uv run pytest --junitxml=reports/backend.xml'
        sh 'uv run python scripts/export_openapi.py'
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'reports/backend.xml'
        }
      }
    }

    stage('API contract') {
      steps {
        sh 'git diff --exit-code -- docs/openapi.json'
      }
    }

    stage('Frontend quality') {
      agent {
        docker {
          image 'node:22-bookworm'
          reuseNode true
        }
      }
      steps {
        sh 'rm -rf src/frontend/.next'
        sh 'corepack enable'
        sh 'corepack pnpm --dir src/frontend install --frozen-lockfile'
        sh 'corepack pnpm --dir src/frontend lint'
        sh 'corepack pnpm --dir src/frontend typecheck'
        sh 'corepack pnpm --dir src/frontend build'
      }
    }

    stage('Production image builds') {
      steps {
        sh 'git submodule update --init --recursive'
        sh 'cp .env.example .env.production'
        sh 'docker compose --env-file .env.production -f deployment/docker-compose.production.yml build'
      }
      post {
        always {
          sh 'rm -f .env.production'
        }
      }
    }
  }
}
