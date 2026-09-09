from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import cast
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_common.database.models.category import Category
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.user import User
from floorsync_common.machines import service as machine_service
from floorsync_common.machines.results import (
    CapabilitiesListed,
    CapabilityNotFound,
    CapabilityRemoved,
    CapabilitySet,
    CategoryCreated,
    CategoryNameAlreadyExists,
    CategoryNotFound,
    MachineCreated,
    MachineFound,
    MachineNameAlreadyExists,
    MachineNotFound,
    MachineUpdated,
    OperationNotFound,
)
from floorsync_common.machines.service import MachinePage
from floorsync_common.pagination import decode_cursor, encode_cursor
from floorsync_common.settings import Settings

CREATED_AT = datetime(2026, 9, 9, 8, tzinfo=UTC)


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_: object) -> None:
        return None


class FakeSession:
    """The service layer is stubbed per test, so the session only has to open a transaction."""

    def begin(self) -> FakeTransaction:
        return FakeTransaction()


def make_machine(**overrides: object) -> Machine:
    values: dict[str, object] = {
        "id": uuid4(),
        "name": "Lathe 1",
        "category_id": None,
        "salary": None,
        "active": True,
        "created_at": CREATED_AT,
        "updated_at": CREATED_AT,
    }
    values.update(overrides)
    return Machine(**values)


def make_capability(machine_id: UUID, operation_id: UUID) -> Compatibility:
    return Compatibility(
        id=uuid4(),
        machine_id=machine_id,
        operation_id=operation_id,
        duration=30,
        energy=Decimal("1.50"),
        created_at=CREATED_AT,
        updated_at=CREATED_AT,
    )


def machine_client(role: str = "manager") -> TestClient:
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


def stub(monkeypatch: pytest.MonkeyPatch, method: str, outcome: object) -> None:
    """Replace one service call with a fixed outcome, so the route's mapping is what is tested."""

    async def fake(*_: object, **__: object) -> object:
        return outcome

    target: Callable[..., object] = machine_service.MachineService
    if method.startswith("create_category") or method.startswith("list_categories"):
        target = machine_service.CategoryService
    monkeypatch.setattr(target, method, staticmethod(fake))


def test_create_machine_returns_201_with_a_location_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    machine = make_machine()
    stub(monkeypatch, "create_machine", MachineCreated(machine=machine))

    response = machine_client().post("/api/v1/machines", json={"name": "Lathe 1"})

    assert response.status_code == 201
    assert response.headers["Location"] == f"/api/v1/machines/{machine.id}"
    assert response.json()["name"] == "Lathe 1"


def test_create_machine_rejects_a_duplicate_name_as_a_conflict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stub(monkeypatch, "create_machine", MachineNameAlreadyExists(name="Lathe 1"))

    response = machine_client().post("/api/v1/machines", json={"name": "Lathe 1"})

    assert response.status_code == 409
    assert response.json()["type"] == "urn:floorsync:problem:machine-name-conflict"


def test_create_machine_rejects_an_unknown_category_as_unprocessable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    category_id = uuid4()
    stub(monkeypatch, "create_machine", CategoryNotFound(category_id=category_id))

    response = machine_client().post(
        "/api/v1/machines",
        json={"name": "Lathe 1", "category_id": str(category_id)},
    )

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:category-not-found"


def test_create_machine_accepts_optional_cost_and_category() -> None:
    """Neither is required: a machine may be entered before its costs are settled."""

    from floorsync_api.features.machines.schemas import MachineCreateRequest

    command = MachineCreateRequest.model_validate({"name": "Lathe 1"})

    assert command.salary is None
    assert command.category_id is None
    assert command.active is True


def test_create_machine_rejects_a_blank_name() -> None:
    response = machine_client().post("/api/v1/machines", json={"name": "   "})

    assert response.status_code == 422


def test_create_machine_rejects_unknown_fields() -> None:
    response = machine_client().post(
        "/api/v1/machines",
        json={"name": "Lathe 1", "colour": "red"},
    )

    assert response.status_code == 422


def test_get_machine_includes_its_capabilities(monkeypatch: pytest.MonkeyPatch) -> None:
    machine = make_machine()
    capability = make_capability(machine.id, uuid4())
    stub(monkeypatch, "get_machine", MachineFound(machine=machine, capabilities=(capability,)))

    response = machine_client().get(f"/api/v1/machines/{machine.id}")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(machine.id)
    assert len(body["capabilities"]) == 1
    assert body["capabilities"][0]["duration"] == 30


def test_get_machine_returns_404_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    machine_id = uuid4()
    stub(monkeypatch, "get_machine", MachineNotFound(machine_id=machine_id))

    response = machine_client().get(f"/api/v1/machines/{machine_id}")

    assert response.status_code == 404


def test_list_machines_returns_a_cursor_page(monkeypatch: pytest.MonkeyPatch) -> None:
    machine = make_machine()
    stub(monkeypatch, "list_machines", MachinePage(machines=(machine,), next_cursor="abc"))

    response = machine_client().get("/api/v1/machines")

    assert response.status_code == 200
    body = response.json()
    assert body["next_cursor"] == "abc"
    assert [item["id"] for item in body["items"]] == [str(machine.id)]


def test_list_machines_rejects_an_out_of_range_limit() -> None:
    response = machine_client().get("/api/v1/machines", params={"limit": 500})

    assert response.status_code == 422


def test_update_machine_applies_a_partial_change(monkeypatch: pytest.MonkeyPatch) -> None:
    machine = make_machine(active=False)
    stub(monkeypatch, "update_machine", MachineUpdated(machine=machine))

    response = machine_client().patch(f"/api/v1/machines/{machine.id}", json={"active": False})

    assert response.status_code == 200
    assert response.json()["active"] is False


def test_update_machine_returns_404_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    machine_id = uuid4()
    stub(monkeypatch, "update_machine", MachineNotFound(machine_id=machine_id))

    response = machine_client().patch(f"/api/v1/machines/{machine_id}", json={"active": False})

    assert response.status_code == 404


def test_update_machine_rejects_an_explicit_null_for_a_required_column() -> None:
    """`name` and `active` are NOT NULL, so clearing them is refused before the database sees it."""

    response = machine_client().patch(f"/api/v1/machines/{uuid4()}", json={"name": None})

    assert response.status_code == 422


def test_update_machine_allows_clearing_a_nullable_column(monkeypatch: pytest.MonkeyPatch) -> None:
    """Salary is nullable, so an explicit null is a legitimate way to say it is no longer known."""

    machine = make_machine(salary=None)
    stub(monkeypatch, "update_machine", MachineUpdated(machine=machine))

    response = machine_client().patch(f"/api/v1/machines/{machine.id}", json={"salary": None})

    assert response.status_code == 200
    assert response.json()["salary"] is None


def test_list_capabilities_returns_what_the_machine_can_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    machine_id = uuid4()
    capability = make_capability(machine_id, uuid4())
    stub(monkeypatch, "list_capabilities", CapabilitiesListed(capabilities=(capability,)))

    response = machine_client().get(f"/api/v1/machines/{machine_id}/capabilities")

    assert response.status_code == 200
    assert response.json()[0]["machine_id"] == str(machine_id)


def test_list_capabilities_separates_an_absent_machine_from_an_empty_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    machine_id = uuid4()
    stub(monkeypatch, "list_capabilities", MachineNotFound(machine_id=machine_id))

    response = machine_client().get(f"/api/v1/machines/{machine_id}/capabilities")

    assert response.status_code == 404


def test_setting_a_new_capability_returns_201(monkeypatch: pytest.MonkeyPatch) -> None:
    machine_id, operation_id = uuid4(), uuid4()
    capability = make_capability(machine_id, operation_id)
    stub(monkeypatch, "set_capability", CapabilitySet(capability=capability, created=True))

    response = machine_client().put(
        f"/api/v1/machines/{machine_id}/capabilities/{operation_id}",
        json={"duration": 30, "energy": "1.50"},
    )

    assert response.status_code == 201
    assert (
        response.headers["Location"] == f"/api/v1/machines/{machine_id}/capabilities/{operation_id}"
    )


def test_restating_a_capability_returns_200(monkeypatch: pytest.MonkeyPatch) -> None:
    """`PUT` is idempotent: re-sending a pairing restates its cost rather than failing."""

    machine_id, operation_id = uuid4(), uuid4()
    capability = make_capability(machine_id, operation_id)
    stub(monkeypatch, "set_capability", CapabilitySet(capability=capability, created=False))

    response = machine_client().put(
        f"/api/v1/machines/{machine_id}/capabilities/{operation_id}",
        json={"duration": 30},
    )

    assert response.status_code == 200


def test_setting_a_capability_for_an_unknown_operation_returns_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    operation_id = uuid4()
    stub(monkeypatch, "set_capability", OperationNotFound(operation_id=operation_id))

    response = machine_client().put(
        f"/api/v1/machines/{uuid4()}/capabilities/{operation_id}",
        json={"duration": 30},
    )

    assert response.status_code == 404


def test_setting_a_capability_rejects_a_non_positive_duration() -> None:
    response = machine_client().put(
        f"/api/v1/machines/{uuid4()}/capabilities/{uuid4()}",
        json={"duration": 0},
    )

    assert response.status_code == 422


def test_removing_a_capability_returns_204(monkeypatch: pytest.MonkeyPatch) -> None:
    machine_id, operation_id = uuid4(), uuid4()
    stub(
        monkeypatch,
        "remove_capability",
        CapabilityRemoved(machine_id=machine_id, operation_id=operation_id),
    )

    response = machine_client().delete(f"/api/v1/machines/{machine_id}/capabilities/{operation_id}")

    assert response.status_code == 204
    assert response.content == b""


def test_removing_an_absent_capability_returns_404(monkeypatch: pytest.MonkeyPatch) -> None:
    machine_id, operation_id = uuid4(), uuid4()
    stub(
        monkeypatch,
        "remove_capability",
        CapabilityNotFound(machine_id=machine_id, operation_id=operation_id),
    )

    response = machine_client().delete(f"/api/v1/machines/{machine_id}/capabilities/{operation_id}")

    assert response.status_code == 404


def test_create_category_returns_201(monkeypatch: pytest.MonkeyPatch) -> None:
    category = Category(id=uuid4(), name="Cutting", created_at=CREATED_AT, updated_at=CREATED_AT)
    stub(monkeypatch, "create_category", CategoryCreated(category=category))

    response = machine_client().post("/api/v1/categories", json={"name": "Cutting"})

    assert response.status_code == 201
    assert response.json()["name"] == "Cutting"


def test_create_category_rejects_a_duplicate_name(monkeypatch: pytest.MonkeyPatch) -> None:
    stub(monkeypatch, "create_category", CategoryNameAlreadyExists(name="Cutting"))

    response = machine_client().post("/api/v1/categories", json={"name": "Cutting"})

    assert response.status_code == 409
    assert response.json()["type"] == "urn:floorsync:problem:category-name-conflict"


def test_machines_are_manager_only() -> None:
    """An operator's own machine is theirs to run, not to reconfigure."""

    response = machine_client(role="operator").get("/api/v1/machines")

    assert response.status_code == 403


def test_update_paths_refresh_database_computed_columns() -> None:
    """Guards a bug these stubbed tests cannot otherwise reach.

    `updated_at` is filled by the database through `onupdate`, so flushing an UPDATE expires it.
    Serialising the row afterwards then triggers a lazy reload, which async SQLAlchemy cannot await
    and reports as MissingGreenlet -- a 500. An INSERT is unaffected, because it returns server
    defaults inline. Only a live database reproduces it, so this asserts the refresh call that fixes
    it is still present rather than the behaviour itself.
    """

    import inspect

    for method in (
        machine_service.MachineService.update_machine,
        machine_service.MachineService.set_capability,
    ):
        source = inspect.getsource(method)
        assert "await db.refresh(" in source, f"{method.__name__} must refresh after flushing"


def test_cursor_round_trips_through_encoding() -> None:
    machine = make_machine(name="Lathe 1")

    cursor = encode_cursor(machine.name, machine.id)

    assert decode_cursor(cursor) == (machine.name, machine.id)


def test_an_unreadable_cursor_restarts_the_collection() -> None:
    """A stale or hand-edited link should show the first page, not a validation error."""

    assert decode_cursor("not-a-cursor") is None
    assert decode_cursor("") is None
    assert decode_cursor(None) is None


def test_a_cursor_survives_a_separator_in_the_sort_value() -> None:
    """Names are free text, so the encoding must not break on one containing the separator."""

    identifier = uuid4()

    assert decode_cursor(encode_cursor("Lathe 1 / Bay 2", identifier)) == (
        "Lathe 1 / Bay 2",
        identifier,
    )
