FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /uvx /bin/
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY alembic.ini ./
COPY src/backend/common ./src/backend/common
COPY src/backend/api ./src/backend/api
COPY src/database ./src/database
EXPOSE 8000
CMD ["uvicorn", "floorsync_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
