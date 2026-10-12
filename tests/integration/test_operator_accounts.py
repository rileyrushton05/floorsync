"""Operator logins follow their machine, proven against a real database.

The API tests stub `OperatorService`, so they cannot show the parts that live in SQL: picking a free
username and its suffix, re-deriving it on a rename, removing it with the machine, and the
uniqueness check on an update.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_api.main import application
from floorsync_common.database.models.user import User


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


def _create_machine(api: TestClient, name: str) -> str:
    response = api.post("/api/v1/machines", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _operator_for(api: TestClient, machine_id: str) -> dict[str, Any]:
    response = api.get("/api/v1/operators")
    assert response.status_code == 200, response.text
    (operator,) = [row for row in response.json() if row["machine_id"] == machine_id]
    return operator


def _sign_in(api: TestClient, username: str, password: str) -> int:
    return api.post(
        "/api/v1/auth/token", data={"username": username, "password": password}
    ).status_code


def test_a_new_machine_gets_a_login_with_the_default_password(api: TestClient) -> None:
    machine_id = _create_machine(api, "CNC Lathe 2")

    operator = _operator_for(api, machine_id)

    assert (operator["username"], operator["name"]) == ("cnc-lathe-2", "CNC Lathe 2")
    assert operator["active"] is True
    password = application.state.settings.operator_default_password
    assert _sign_in(api, "cnc-lathe-2", password) == 200


def test_a_taken_username_gets_the_next_free_suffix(api: TestClient) -> None:
    usernames = [
        _operator_for(api, _create_machine(api, name))["username"]
        for name in ("Lathe 1", "lathe-1", "LATHE/1")
    ]

    assert usernames == ["lathe-1", "lathe-1-2", "lathe-1-3"]


def test_renaming_a_machine_re_derives_the_username(api: TestClient) -> None:
    machine_id = _create_machine(api, "Lathe A")

    renamed = api.patch(f"/api/v1/machines/{machine_id}", json={"name": "Lathe B"})

    assert renamed.status_code == 200, renamed.text
    operator = _operator_for(api, machine_id)
    assert (operator["username"], operator["name"]) == ("lathe-b", "Lathe B")


def test_renaming_a_machine_keeps_a_display_name_a_manager_chose(api: TestClient) -> None:
    machine_id = _create_machine(api, "Lathe A")
    operator_id = _operator_for(api, machine_id)["id"]
    api.patch(f"/api/v1/operators/{operator_id}", json={"name": "Sam"})

    api.patch(f"/api/v1/machines/{machine_id}", json={"name": "Lathe B"})

    operator = _operator_for(api, machine_id)
    assert (operator["username"], operator["name"]) == ("lathe-b", "Sam")


def test_renaming_a_machine_does_not_suffix_its_own_username(api: TestClient) -> None:
    machine_id = _create_machine(api, "Lathe A")

    api.patch(f"/api/v1/machines/{machine_id}", json={"name": "LATHE A"})

    assert _operator_for(api, machine_id)["username"] == "lathe-a"


def test_removing_a_machine_removes_its_login(api: TestClient) -> None:
    machine_id = _create_machine(api, "Lathe A")

    removed = api.delete(f"/api/v1/machines/{machine_id}")

    assert removed.status_code == 204, removed.text
    assert api.get("/api/v1/operators").json() == []


def test_updating_a_login_changes_how_it_signs_in(api: TestClient) -> None:
    machine_id = _create_machine(api, "Lathe A")
    operator_id = _operator_for(api, machine_id)["id"]

    updated = api.patch(
        f"/api/v1/operators/{operator_id}",
        json={"username": "  Sam.Lathe ", "password": "a-new-password"},
    )

    assert updated.status_code == 200, updated.text
    assert updated.json()["username"] == "sam.lathe"
    assert _sign_in(api, "sam.lathe", "a-new-password") == 200
    assert _sign_in(api, "lathe-a", application.state.settings.operator_default_password) == 401


def test_a_disabled_login_cannot_sign_in(api: TestClient) -> None:
    machine_id = _create_machine(api, "Lathe A")
    operator_id = _operator_for(api, machine_id)["id"]

    api.patch(f"/api/v1/operators/{operator_id}", json={"active": False})

    password = application.state.settings.operator_default_password
    assert _sign_in(api, "lathe-a", password) == 401


def test_a_username_another_login_uses_is_a_conflict(api: TestClient) -> None:
    _create_machine(api, "Lathe A")
    operator_id = _operator_for(api, _create_machine(api, "Lathe B"))["id"]

    response = api.patch(f"/api/v1/operators/{operator_id}", json={"username": "lathe-a"})

    assert response.status_code == 409, response.text
    assert response.json()["type"] == "urn:floorsync:problem:username-conflict"


def test_keeping_the_current_username_is_not_a_conflict(api: TestClient) -> None:
    operator_id = _operator_for(api, _create_machine(api, "Lathe A"))["id"]

    response = api.patch(f"/api/v1/operators/{operator_id}", json={"username": "LATHE-A"})

    assert response.status_code == 200, response.text


def test_a_non_ascii_username_is_rejected(api: TestClient) -> None:
    operator_id = _operator_for(api, _create_machine(api, "Lathe A"))["id"]

    response = api.patch(f"/api/v1/operators/{operator_id}", json={"username": "İnci"})

    assert response.status_code == 422, response.text
