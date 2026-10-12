"""Category names and deletes, proven against a real database.

The API tests stub `CategoryService`, so they cannot show what lives in SQL: the case-insensitive
unique index deciding a name clash, and the locks that make a delete and a concurrent write end as
if one had run first. Each race holds one transaction open, waits until the other is blocked on a
lock in PostgreSQL, then commits.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_api.main import application
from floorsync_common.database.models.user import User
from floorsync_common.machines.results import (
    CategoryInUse,
    CategoryNameAlreadyExists,
    CategoryNotFound,
    CategoryRenamed,
    MachineCreated,
)
from floorsync_common.machines.service import CategoryService, MachineService

type Work = Callable[[AsyncSession], Awaitable[object]]


@pytest.fixture
def api(database_url: str) -> Iterator[TestClient]:
    """The real app, its sessions bound to the test database and its caller a signed-in manager."""
    engine = create_async_engine(database_url, poolclass=NullPool)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autobegin=False)

    async def db_session() -> AsyncIterator[AsyncSession]:
        async with sessions() as session:
            yield session

    async def manager() -> User:
        return User(id=uuid4(), name="Manager", role="manager")

    application.dependency_overrides[get_db_session] = db_session
    application.dependency_overrides[get_current_user] = manager
    try:
        yield TestClient(application)
    finally:
        application.dependency_overrides.clear()
        asyncio.run(engine.dispose())


def _create_category(api: TestClient, name: str) -> str:
    response = api.post("/api/v1/categories", json={"name": name})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def _category_names(api: TestClient) -> list[str]:
    return [category["name"] for category in api.get("/api/v1/categories").json()]


def test_a_name_differing_only_in_case_is_refused(api: TestClient) -> None:
    _create_category(api, "Cutting")

    response = api.post("/api/v1/categories", json={"name": " cutting "})

    assert response.status_code == 409
    assert response.json()["detail"] == "A category named 'Cutting' already exists."
    assert _category_names(api) == ["Cutting"]


def test_renaming_keeps_the_category_on_its_machines(api: TestClient) -> None:
    category_id = _create_category(api, "Cuting")
    machine = api.post("/api/v1/machines", json={"name": "Saw 1", "category_id": category_id})

    renamed = api.patch(f"/api/v1/categories/{category_id}", json={"name": "Cutting"})

    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Cutting"
    assert api.get(f"/api/v1/machines/{machine.json()['id']}").json()["category_id"] == category_id


def test_a_category_may_change_only_its_own_capitalisation(api: TestClient) -> None:
    category_id = _create_category(api, "cutting")

    response = api.patch(f"/api/v1/categories/{category_id}", json={"name": "Cutting"})

    assert response.status_code == 200, response.text
    assert _category_names(api) == ["Cutting"]


def test_renaming_onto_another_category_is_refused(api: TestClient) -> None:
    _create_category(api, "Cutting")
    polishing_id = _create_category(api, "Polishing")

    response = api.patch(f"/api/v1/categories/{polishing_id}", json={"name": "CUTTING"})

    assert response.status_code == 409
    assert response.json()["detail"] == "A category named 'Cutting' already exists."
    assert _category_names(api) == ["Cutting", "Polishing"]


def test_renaming_an_absent_category_is_not_found(api: TestClient) -> None:
    response = api.patch(f"/api/v1/categories/{uuid4()}", json={"name": "Cutting"})

    assert response.status_code == 404


def test_an_unused_category_can_be_deleted(api: TestClient) -> None:
    category_id = _create_category(api, "Cutting")

    response = api.delete(f"/api/v1/categories/{category_id}")

    assert response.status_code == 204
    assert _category_names(api) == []
    assert api.delete(f"/api/v1/categories/{category_id}").status_code == 404


def test_a_category_in_use_is_not_deleted(api: TestClient) -> None:
    category_id = _create_category(api, "Cutting")
    for name in ("Saw 1", "Saw 2"):
        api.post("/api/v1/machines", json={"name": name, "category_id": category_id})

    response = api.delete(f"/api/v1/categories/{category_id}")

    assert response.status_code == 409
    assert response.json()["type"] == "urn:floorsync:problem:category-in-use"
    assert response.json()["detail"].startswith("2 machines are still in this category.")
    assert _category_names(api) == ["Cutting"]


async def _blocked_on_a_lock(engine: AsyncEngine) -> None:
    """Return once another session of this database is waiting for a lock."""
    async with engine.connect() as connection:
        for _ in range(500):
            waiting = await connection.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE datname = current_database() AND wait_event_type = 'Lock'"
                )
            )
            if waiting:
                return
            await asyncio.sleep(0.01)
    raise AssertionError("the second transaction never waited for a lock")


async def _race(database_url: str, first: Work, second: Work) -> object:
    """Run `first` and hold its transaction open while `second` blocks on it, then commit.

    Returns what `second` returned once it was let through. Its transaction then commits too.
    """
    engine = create_async_engine(database_url, poolclass=NullPool)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autobegin=False)

    async def in_transaction(work: Work) -> object:
        async with sessions() as db, db.begin():
            return await work(db)

    try:
        async with sessions() as holder, holder.begin():
            await first(holder)
            waiter = asyncio.create_task(in_transaction(second))
            await _blocked_on_a_lock(engine)
        return await waiter
    finally:
        await engine.dispose()


async def _seed_category(database_url: str, name: str) -> UUID:
    engine = create_async_engine(database_url, poolclass=NullPool)
    try:
        async with engine.begin() as connection:
            category_id = uuid4()
            await connection.execute(
                text("INSERT INTO categories (id, name) VALUES (:id, :name)"),
                {"id": category_id, "name": name},
            )
            return category_id
    finally:
        await engine.dispose()


async def _create_machine(db: AsyncSession, category_id: UUID) -> object:
    return await MachineService.create_machine(
        db, name=f"Saw {uuid4().hex[:6]}", category_id=category_id, operator_password="x"
    )


def test_two_creates_of_one_name_end_with_one_category(database_url: str) -> None:
    """The second create waits for the first's uncommitted row, then is refused, never a 500."""

    async def scenario() -> object:
        return await _race(
            database_url,
            lambda db: CategoryService.create_category(db, name="Cutting"),
            lambda db: CategoryService.create_category(db, name="cutting"),
        )

    assert asyncio.run(scenario()) == CategoryNameAlreadyExists(name="Cutting")


def test_a_rename_racing_a_create_onto_its_name_is_refused(database_url: str) -> None:
    async def scenario() -> object:
        category_id = await _seed_category(database_url, "Polishing")
        return await _race(
            database_url,
            lambda db: CategoryService.create_category(db, name="Cutting"),
            lambda db: CategoryService.rename_category(db, category_id, name="CUTTING"),
        )

    assert asyncio.run(scenario()) == CategoryNameAlreadyExists(name="Cutting")


def test_a_machine_assigned_while_the_category_is_deleted_is_refused(database_url: str) -> None:
    """The delete commits first; the machine waits at its category check, then finds it gone."""

    async def scenario() -> tuple[UUID, object]:
        category_id = await _seed_category(database_url, "Cutting")
        outcome = await _race(
            database_url,
            lambda db: CategoryService.remove_category(db, category_id),
            lambda db: _create_machine(db, category_id),
        )
        return category_id, outcome

    category_id, outcome = asyncio.run(scenario())
    assert outcome == CategoryNotFound(category_id=category_id)


def test_a_delete_while_a_machine_is_assigned_counts_it(database_url: str) -> None:
    """The machine commits first; the delete waits at its lock, then sees it and refuses."""

    async def scenario() -> tuple[UUID, object]:
        category_id = await _seed_category(database_url, "Cutting")
        outcome = await _race(
            database_url,
            lambda db: _create_machine(db, category_id),
            lambda db: CategoryService.remove_category(db, category_id),
        )
        return category_id, outcome

    category_id, outcome = asyncio.run(scenario())
    assert outcome == CategoryInUse(category_id=category_id, machine_count=1)


def test_a_rename_while_the_category_is_deleted_is_not_found(database_url: str) -> None:
    async def scenario() -> tuple[UUID, object]:
        category_id = await _seed_category(database_url, "Cutting")
        outcome = await _race(
            database_url,
            lambda db: CategoryService.remove_category(db, category_id),
            lambda db: CategoryService.rename_category(db, category_id, name="Saws"),
        )
        return category_id, outcome

    category_id, outcome = asyncio.run(scenario())
    assert outcome == CategoryNotFound(category_id=category_id)


def test_a_rename_does_not_wait_for_a_machine_being_assigned(database_url: str) -> None:
    """Renaming leaves the category's key alone, so it need not wait for a machine joining it."""

    async def scenario() -> tuple[object, object]:
        category_id = await _seed_category(database_url, "Cuting")
        engine = create_async_engine(database_url, poolclass=NullPool)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autobegin=False)
        try:
            async with sessions() as holder, holder.begin():
                created = await _create_machine(holder, category_id)
                async with sessions() as db, db.begin():
                    renamed = await asyncio.wait_for(
                        CategoryService.rename_category(db, category_id, name="Cutting"), 5
                    )
            return created, renamed
        finally:
            await engine.dispose()

    created, renamed = asyncio.run(scenario())
    assert isinstance(created, MachineCreated)
    assert isinstance(renamed, CategoryRenamed)
