from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import cast
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_common.database.models.user import User
from floorsync_common.database.models.user_credential import UserCredential
from floorsync_common.settings import Settings
from floorsync_common.users import (
    AssignedMachineHasNoOperator,
    AssignedMachineNotFound,
    OperatorAccount,
    OperatorNotFound,
    OperatorService,
    OperatorUpdated,
    UsernameAlreadyExists,
    operator_username_base,
)

CREATED_AT = datetime(2026, 10, 8, 8, tzinfo=UTC)


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_: object) -> None:
        return None


class FakeSession:
    """The service layer is stubbed per test, so the session only has to open a transaction."""

    def begin(self) -> FakeTransaction:
        return FakeTransaction()


def make_account(username: str = "abz5-m0") -> OperatorAccount:
    user = User(
        id=uuid4(),
        name="abz5/M0",
        role="operator",
        machine_id=uuid4(),
        created_at=CREATED_AT,
        updated_at=CREATED_AT,
    )
    credential = UserCredential(
        id=uuid4(),
        user_id=user.id,
        username=username,
        password_hash="argon2-hash",
        active=True,
        last_authenticated_at=None,
    )
    return OperatorAccount(user=user, credential=credential, machine_name="abz5/M0")


def operator_client(role: str = "manager") -> TestClient:
    from floorsync_api.main import create_application

    application: FastAPI = create_application(Settings(environment="test"))
    user = User(id=uuid4(), name="Ada Manager", role=role, machine_id=None)

    async def get_test_db_session() -> AsyncIterator[AsyncSession]:
        yield cast(AsyncSession, FakeSession())

    async def get_test_current_user() -> User:
        return user

    application.dependency_overrides[get_db_session] = get_test_db_session
    application.dependency_overrides[get_current_user] = get_test_current_user
    return TestClient(application)


def stub(monkeypatch: pytest.MonkeyPatch, method: str, outcome: object) -> dict[str, object]:
    """Replace one service call with a fixed outcome, recording the keyword arguments it got."""

    received: dict[str, object] = {}

    async def fake(*_: object, **kwargs: object) -> object:
        received.update(kwargs)
        return outcome

    monkeypatch.setattr(OperatorService, method, staticmethod(fake))
    return received


@pytest.mark.parametrize(
    ("machine_name", "username"),
    [
        ("abz5/M0", "abz5-m0"),
        ("CNC Lathe 2", "cnc-lathe-2"),
        ("  --Weld  bay!! ", "weld-bay"),
        ("///", "operator"),
    ],
)
def test_operator_username_is_a_slug_of_the_machine_name(machine_name: str, username: str) -> None:
    assert operator_username_base(machine_name) == username


def test_list_operators_never_exposes_the_password_hash(monkeypatch: pytest.MonkeyPatch) -> None:
    account = make_account()
    stub(monkeypatch, "list_operators", (account,))

    response = operator_client().get("/api/v1/operators")

    assert response.status_code == 200
    [body] = response.json()
    assert body["username"] == "abz5-m0"
    assert body["machine_name"] == "abz5/M0"
    assert body["machine_id"] == str(account.user.machine_id)
    assert "password" not in body and "password_hash" not in body


def test_update_operator_passes_only_the_fields_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    account = make_account(username="line-a")
    received = stub(monkeypatch, "update_operator", OperatorUpdated(account=account))

    response = operator_client().patch(
        f"/api/v1/operators/{account.user.id}",
        json={"username": "  Line-A ", "password": " keep spaces "},
    )

    assert response.status_code == 200
    assert received["username"] == "line-a"
    assert received["password"] == " keep spaces "
    assert repr(received["name"]) == "UNSET"
    assert repr(received["machine_id"]) == "UNSET"


def test_update_operator_rejects_an_explicit_null() -> None:
    response = operator_client().patch(f"/api/v1/operators/{uuid4()}", json={"password": None})

    assert response.status_code == 422


def test_update_operator_rejects_an_empty_password() -> None:
    response = operator_client().patch(f"/api/v1/operators/{uuid4()}", json={"password": ""})

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("outcome", "status", "problem"),
    [
        (OperatorNotFound(user_id=uuid4()), 404, None),
        (UsernameAlreadyExists(username="manager"), 409, "urn:floorsync:problem:username-conflict"),
        (
            AssignedMachineNotFound(machine_id=uuid4()),
            422,
            "urn:floorsync:problem:machine-not-found",
        ),
        (
            AssignedMachineHasNoOperator(machine_id=uuid4()),
            422,
            "urn:floorsync:problem:machine-has-no-operator",
        ),
    ],
)
def test_update_operator_maps_each_rejection(
    monkeypatch: pytest.MonkeyPatch, outcome: object, status: int, problem: str | None
) -> None:
    stub(monkeypatch, "update_operator", outcome)

    response = operator_client().patch(
        f"/api/v1/operators/{uuid4()}", json={"machine_id": str(uuid4())}
    )

    assert response.status_code == status
    if problem is not None:
        assert response.json()["type"] == problem


def test_operators_are_manager_only() -> None:
    client = operator_client(role="operator")

    assert client.get("/api/v1/operators").status_code == 403
    assert client.patch(f"/api/v1/operators/{uuid4()}", json={"active": False}).status_code == 403


def test_operators_cannot_be_created_on_their_own() -> None:
    """Every operator comes with a machine, so there is deliberately no create route."""

    assert operator_client().post("/api/v1/operators", json={}).status_code == 405
