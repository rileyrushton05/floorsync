"""A real, migrated PostgreSQL database for tests that need one.

Some guarantees only Postgres can give: two statements committing or rolling back together, a row
lock making a second transaction wait, `SKIP LOCKED` handing two relays disjoint rows. A fake
session cannot prove any of them, so tests of those guarantees ask for the `database_url` fixture
and run against a real database.

The database is `FLOORSYNC_TEST_DATABASE_URL`, defaulting to `floorsync_test` on the Compose
Postgres published on the host (port 5433). It is created if missing, migrated to head once per
run, and emptied after every test that used it. The fixture refuses any database whose name does
not end in `_test`, because emptying it is the point. When no Postgres answers, the tests that
need it skip, so a plain `uv run pytest` without a database still passes. Setting
`FLOORSYNC_REQUIRE_TEST_DATABASE=1` turns that skip into a failure, for a CI run that has started a
database precisely to run these tests and must not pass green by skipping them.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

import floorsync_common.database.models  # noqa: F401  (registers every table on the metadata)
from floorsync_common.database.base import Base

REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_DATABASE_URL = os.environ.get(
    "FLOORSYNC_TEST_DATABASE_URL",
    "postgresql+asyncpg://floorsync:floorsync@localhost:5433/floorsync_test",
)
REQUIRE_DATABASE = os.environ.get("FLOORSYNC_REQUIRE_TEST_DATABASE") == "1"
CONNECT_TIMEOUT_SECONDS = 2


async def _create_database_if_missing(url: str) -> None:
    """Connect to the server's maintenance database and create the test database if needed."""
    target = make_url(url)
    maintenance = create_async_engine(
        target.set(database="postgres"),
        isolation_level="AUTOCOMMIT",
        poolclass=NullPool,
        connect_args={"timeout": CONNECT_TIMEOUT_SECONDS},
    )
    try:
        async with maintenance.connect() as connection:
            exists = await connection.scalar(
                text("SELECT 1 FROM pg_database WHERE datname = :name"),
                {"name": target.database},
            )
            if not exists:
                await connection.execute(text(f'CREATE DATABASE "{target.database}"'))
    finally:
        await maintenance.dispose()


async def _empty_every_table(url: str) -> None:
    engine = create_async_engine(url, poolclass=NullPool)
    tables = ", ".join(f'"{table.name}"' for table in Base.metadata.sorted_tables)
    try:
        async with engine.begin() as connection:
            await connection.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    finally:
        await engine.dispose()


@pytest.fixture(scope="session")
def migrated_database_url() -> str:
    """The test database, created if missing and migrated to head. Skips when unreachable."""
    database = make_url(TEST_DATABASE_URL).database or ""
    if not database.endswith("_test"):
        pytest.fail(
            f"FLOORSYNC_TEST_DATABASE_URL names database {database!r}; integration tests empty "
            "every table, so they only run against a database whose name ends in '_test'."
        )
    try:
        asyncio.run(_create_database_if_missing(TEST_DATABASE_URL))
    except (OSError, TimeoutError) as error:
        message = f"No PostgreSQL reachable for integration tests ({error})."
        if REQUIRE_DATABASE:
            pytest.fail(message)
        pytest.skip(message)

    migration = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=REPO_ROOT,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL},
        capture_output=True,
        text=True,
        check=False,
    )
    if migration.returncode != 0:
        pytest.fail(f"Could not migrate the test database:\n{migration.stderr}")
    return TEST_DATABASE_URL


@pytest.fixture
def database_url(migrated_database_url: str) -> Iterator[str]:
    """A migrated test database, emptied again once the test finishes."""
    yield migrated_database_url
    asyncio.run(_empty_every_table(migrated_database_url))
