"""Values PostgreSQL computes on an UPDATE reach the response, proven against a real database.

`updated_at` is computed by the database (`onupdate=func.now()`), so unless the new value comes
back with the UPDATE, SQLAlchemy expires it and the next read needs a lazy reload, which async
SQLAlchemy cannot do: it raises `MissingGreenlet` and the request fails with a 500. A NUMERIC(10, 2)
column is rounded by PostgreSQL on write. A fake session does neither, so only a real database
shows them.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from floorsync_common.database.models.job import Job
from floorsync_common.database.models.machine import Machine


def _active_machine(database_url: str) -> str:
    async def create() -> str:
        engine = create_async_engine(database_url, poolclass=NullPool)
        try:
            async with AsyncSession(engine) as db, db.begin():
                machine = Machine(name=f"M-{uuid4().hex[:6]}")
                db.add(machine)
                await db.flush()
                return str(machine.id)
        finally:
            await engine.dispose()

    return asyncio.run(create())


def _stored_updated_at(database_url: str, job_id: str) -> datetime:
    async def load() -> datetime:
        engine = create_async_engine(database_url, poolclass=NullPool)
        try:
            async with AsyncSession(engine) as db, db.begin():
                stored = await db.scalar(select(Job.updated_at).where(Job.id == UUID(job_id)))
                assert stored is not None
                return stored
        finally:
            await engine.dispose()

    return asyncio.run(load())


@pytest.mark.parametrize(
    ("name", "priority"),
    [("Bracket (revised)", "med"), ("Bracket", "high")],
    ids=["rename", "priority-change"],
)
def test_replacing_a_definition_that_changes_the_job_row_succeeds(
    database_url: str, api: TestClient, name: str, priority: str
) -> None:
    route = {"machine_id": _active_machine(database_url), "duration_minutes": 5, "energy": 1}
    created = api.post(
        "/api/v1/job-definitions",
        json={
            "name": "Bracket",
            "priority": "med",
            "operations": [{"name": "cut", "routes": [route]}],
        },
    )
    assert created.status_code == 201, created.text
    job = created.json()

    replaced = api.put(
        f"/api/v1/jobs/{job['id']}/definition",
        json={
            "name": name,
            "priority": priority,
            "operations": [{"id": job["operations"][0]["id"], "name": "cut", "routes": [route]}],
        },
    )

    assert replaced.status_code == 200, replaced.text
    body = replaced.json()
    assert (body["name"], body["priority"]) == (name, priority)
    stored = _stored_updated_at(database_url, job["id"])
    assert datetime.fromisoformat(body["updated_at"]) == stored
    assert stored > datetime.fromisoformat(job["updated_at"])


def test_updating_a_machine_returns_the_salary_postgres_stored(
    database_url: str, api: TestClient
) -> None:
    machine_id = _active_machine(database_url)

    updated = api.patch(f"/api/v1/machines/{machine_id}", json={"salary": "12.555"})

    assert updated.status_code == 200, updated.text
    assert Decimal(str(updated.json()["salary"])) == Decimal("12.56")


def test_updating_a_capability_returns_the_energy_postgres_stored(
    database_url: str, api: TestClient
) -> None:
    machine_id = _active_machine(database_url)
    route = {"machine_id": machine_id, "duration_minutes": 5, "energy": 1}
    created = api.post(
        "/api/v1/job-definitions",
        json={
            "name": "Bracket",
            "priority": "med",
            "operations": [{"name": "cut", "routes": [route]}],
        },
    )
    assert created.status_code == 201, created.text
    operation_id = created.json()["operations"][0]["id"]

    updated = api.put(
        f"/api/v1/machines/{machine_id}/capabilities/{operation_id}",
        json={"duration": 5, "energy": "2.345"},
    )

    assert updated.status_code == 200, updated.text
    assert Decimal(str(updated.json()["energy"])) == Decimal("2.35")


def test_an_update_returns_the_new_updated_at_instead_of_expiring_it(database_url: str) -> None:
    async def exercise() -> None:
        engine = create_async_engine(database_url, poolclass=NullPool)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autobegin=False)
        try:
            async with sessions() as db, db.begin():
                job = Job(name="before")
                db.add(job)
            original = job.updated_at

            async with sessions() as db, db.begin():
                loaded = await db.get(Job, job.id)
                assert loaded is not None
                loaded.name = "after"
                await db.flush()

                assert "updated_at" not in inspect(loaded).unloaded
                # A plain attribute read: an expired value would raise MissingGreenlet here.
                assert loaded.updated_at > original
                stored = await db.scalar(select(Job.updated_at).where(Job.id == job.id))
                assert loaded.updated_at == stored
        finally:
            await engine.dispose()

    asyncio.run(exercise())
