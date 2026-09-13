"""Tests for the job-definition builder: routes, schemas and the service's structural invariants.

Router tests stub `JobDefinitionService`, mirroring `test_jobs_api.py` -- this repository has no
real-database test fixture, so what is asserted here is the route's mapping of a service outcome to
HTTP status/JSON, and the request schema's own validation. Service-level correctness of the SQL
this issues (atomicity, cascade behaviour, the deferred position constraint) is reviewed against
`floorsync_common/operations/service.py`'s already-verified `replace_job_dependencies`, which this
follows the same shape as, and spot-checked here with source-level structural assertions for the
invariants a stubbed session cannot exercise -- the same substitute pattern
`test_get_job_orders_operations_by_position` and
`test_update_job_refreshes_database_computed_columns` already use in `test_jobs_api.py`.
"""

import inspect
from collections.abc import AsyncIterator
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
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.user import User
from floorsync_common.jobs import definitions as definitions_service
from floorsync_common.jobs.definition_results import (
    DefinitionCreated,
    DefinitionFound,
    DefinitionReplaced,
    DefinitionsListed,
    InactiveMachine,
    JobDefinitionIsScheduled,
    JobDefinitionRead,
    OperationDoesNotBelongToJob,
    OperationWithRoutes,
    UnknownMachine,
)
from floorsync_common.jobs.definitions import DefinitionPage, JobDefinitionService
from floorsync_common.jobs.results import JobNotFound
from floorsync_common.settings import Settings

CREATED_AT = datetime(2026, 9, 12, 8, tzinfo=UTC)
MACHINE_ID = UUID("d3c341ee-48d7-4be7-8626-8a6c0e1376f6")


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_: object) -> None:
        return None


class FakeSession:
    """The service layer is stubbed per test, so the session only has to open a transaction."""

    def begin(self) -> FakeTransaction:
        return FakeTransaction()


def make_job(name: str = "Repair conveyor", priority: str = "high") -> Job:
    return Job(
        id=uuid4(), name=name, priority=priority, created_at=CREATED_AT, updated_at=CREATED_AT
    )


def make_operation(job_id: UUID, name: str = "Inspect rollers", position: int = 1) -> Operation:
    return Operation(
        id=uuid4(),
        job_id=job_id,
        name=name,
        position=position,
        created_at=CREATED_AT,
        updated_at=CREATED_AT,
    )


def make_route(operation_id: UUID, machine_id: UUID = MACHINE_ID) -> Compatibility:
    return Compatibility(
        id=uuid4(),
        operation_id=operation_id,
        machine_id=machine_id,
        duration=45,
        energy=Decimal("1.25"),
        created_at=CREATED_AT,
        updated_at=CREATED_AT,
    )


def make_definition(name: str = "Repair conveyor") -> JobDefinitionRead:
    job = make_job(name)
    operation = make_operation(job.id)
    return JobDefinitionRead(
        job=job,
        operations=(OperationWithRoutes(operation=operation, routes=(make_route(operation.id),)),),
    )


def definition_client(role: str = "manager") -> TestClient:
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
    async def fake(*_: object, **__: object) -> object:
        return outcome

    monkeypatch.setattr(JobDefinitionService, method, staticmethod(fake))


VALID_CREATE_BODY = {
    "name": "Repair conveyor",
    "priority": "high",
    "operations": [
        {
            "name": "Inspect rollers",
            "routes": [{"machine_id": str(MACHINE_ID), "duration_minutes": 45, "energy": "1.25"}],
        }
    ],
}


# -- create ---------------------------------------------------------------------------------


def test_create_definition_returns_201_with_location(monkeypatch: pytest.MonkeyPatch) -> None:
    definition = make_definition()
    stub(monkeypatch, "create_definition", DefinitionCreated(definition=definition))

    response = definition_client().post("/api/v1/job-definitions", json=VALID_CREATE_BODY)

    assert response.status_code == 201
    assert response.headers["Location"] == f"/api/v1/jobs/{definition.job.id}/definition"
    body = response.json()
    assert body["name"] == "Repair conveyor"
    assert body["priority"] == "high"
    assert body["operations"][0]["routes"][0]["duration_minutes"] == 45
    assert body["operations"][0]["routes"][0]["energy"] == "1.25"


def test_create_definition_reports_an_unknown_machine(monkeypatch: pytest.MonkeyPatch) -> None:
    stub(monkeypatch, "create_definition", UnknownMachine(machine_id=MACHINE_ID))

    response = definition_client().post("/api/v1/job-definitions", json=VALID_CREATE_BODY)

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:unknown_machine"


def test_create_definition_reports_an_inactive_machine(monkeypatch: pytest.MonkeyPatch) -> None:
    stub(monkeypatch, "create_definition", InactiveMachine(machine_id=MACHINE_ID))

    response = definition_client().post("/api/v1/job-definitions", json=VALID_CREATE_BODY)

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:inactive_machine"


def test_create_definition_rejects_a_blank_operations_list() -> None:
    body = {**VALID_CREATE_BODY, "operations": []}

    response = definition_client().post("/api/v1/job-definitions", json=body)

    assert response.status_code == 422


def test_create_definition_rejects_an_operation_with_no_routes() -> None:
    body = {
        **VALID_CREATE_BODY,
        "operations": [{"name": "Inspect rollers", "routes": []}],
    }

    response = definition_client().post("/api/v1/job-definitions", json=body)

    assert response.status_code == 422


def test_create_definition_rejects_a_duplicate_machine_within_one_operation() -> None:
    body = {
        **VALID_CREATE_BODY,
        "operations": [
            {
                "name": "Inspect rollers",
                "routes": [
                    {"machine_id": str(MACHINE_ID), "duration_minutes": 45, "energy": "1.25"},
                    {"machine_id": str(MACHINE_ID), "duration_minutes": 30, "energy": None},
                ],
            }
        ],
    }

    response = definition_client().post("/api/v1/job-definitions", json=body)

    assert response.status_code == 422


def test_create_definition_rejects_an_unknown_priority() -> None:
    body = {**VALID_CREATE_BODY, "priority": "urgent"}

    response = definition_client().post("/api/v1/job-definitions", json=body)

    assert response.status_code == 422


def test_create_definition_rejects_a_non_positive_duration() -> None:
    body = {
        **VALID_CREATE_BODY,
        "operations": [
            {
                "name": "Inspect rollers",
                "routes": [{"machine_id": str(MACHINE_ID), "duration_minutes": 0}],
            }
        ],
    }

    response = definition_client().post("/api/v1/job-definitions", json=body)

    assert response.status_code == 422


def test_job_definitions_are_manager_only() -> None:
    response = definition_client(role="operator").get("/api/v1/job-definitions")

    assert response.status_code == 403


# -- list -------------------------------------------------------------------------------------


def test_list_definitions_returns_a_cursor_page(monkeypatch: pytest.MonkeyPatch) -> None:
    definition = make_definition()
    stub(
        monkeypatch,
        "list_definitions",
        DefinitionsListed(definitions=(definition,), next_cursor="abc"),
    )

    response = definition_client().get("/api/v1/job-definitions")

    assert response.status_code == 200
    body = response.json()
    assert body["next_cursor"] == "abc"
    assert [item["id"] for item in body["items"]] == [str(definition.job.id)]


def test_list_definitions_rejects_an_out_of_range_limit() -> None:
    response = definition_client().get("/api/v1/job-definitions", params={"limit": 500})

    assert response.status_code == 422


# -- get --------------------------------------------------------------------------------------


def test_get_definition_returns_the_complete_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    definition = make_definition()
    stub(monkeypatch, "get_definition", DefinitionFound(definition=definition))

    response = definition_client().get(f"/api/v1/jobs/{definition.job.id}/definition")

    assert response.status_code == 200
    body = response.json()
    operation = definition.operations[0].operation
    assert body["operations"][0]["id"] == str(operation.id)
    assert body["operations"][0]["position"] == operation.position
    assert body["operations"][0]["name"] == operation.name


def test_get_definition_returns_404_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    stub(monkeypatch, "get_definition", JobNotFound(job_id=job_id))

    response = definition_client().get(f"/api/v1/jobs/{job_id}/definition")

    assert response.status_code == 404
    assert response.json()["type"] == "urn:floorsync:problem:job-not-found"


# -- replace ------------------------------------------------------------------------------------


def replace_body(operation_id: UUID | None = None) -> dict[str, object]:
    operation: dict[str, object] = {
        "name": "Inspect rollers",
        "routes": [{"machine_id": str(MACHINE_ID), "duration_minutes": 45, "energy": "1.25"}],
    }
    if operation_id is not None:
        operation["id"] = str(operation_id)
    return {"name": "Repair conveyor", "priority": "low", "operations": [operation]}


def test_replace_definition_returns_the_replaced_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    definition = make_definition()
    stub(monkeypatch, "replace_definition", DefinitionReplaced(definition=definition))

    response = definition_client().put(
        f"/api/v1/jobs/{definition.job.id}/definition", json=replace_body()
    )

    assert response.status_code == 200
    assert response.json()["name"] == definition.job.name


def test_replace_definition_returns_404_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    stub(monkeypatch, "replace_definition", JobNotFound(job_id=job_id))

    response = definition_client().put(f"/api/v1/jobs/{job_id}/definition", json=replace_body())

    assert response.status_code == 404
    assert response.json()["type"] == "urn:floorsync:problem:job-not-found"


def test_replace_definition_refuses_when_scheduled(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    stub(monkeypatch, "replace_definition", JobDefinitionIsScheduled(job_id=job_id))

    response = definition_client().put(f"/api/v1/jobs/{job_id}/definition", json=replace_body())

    assert response.status_code == 409
    assert response.json()["type"] == "urn:floorsync:problem:job_definition_is_scheduled"


def test_replace_definition_reports_an_operation_from_another_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id, operation_id = uuid4(), uuid4()
    stub(
        monkeypatch,
        "replace_definition",
        OperationDoesNotBelongToJob(operation_id=operation_id, job_id=job_id),
    )

    response = definition_client().put(
        f"/api/v1/jobs/{job_id}/definition", json=replace_body(operation_id)
    )

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:operation_does_not_belong_to_job"


def test_replace_definition_reports_an_unknown_machine(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    stub(monkeypatch, "replace_definition", UnknownMachine(machine_id=MACHINE_ID))

    response = definition_client().put(f"/api/v1/jobs/{job_id}/definition", json=replace_body())

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:unknown_machine"


def test_replace_definition_rejects_a_duplicate_operation_id() -> None:
    operation_id = str(uuid4())
    body = {
        "name": "Repair conveyor",
        "priority": "med",
        "operations": [
            {
                "id": operation_id,
                "name": "Inspect rollers",
                "routes": [{"machine_id": str(MACHINE_ID), "duration_minutes": 45}],
            },
            {
                "id": operation_id,
                "name": "Inspect rollers again",
                "routes": [{"machine_id": str(MACHINE_ID), "duration_minutes": 20}],
            },
        ],
    }

    response = definition_client().put(f"/api/v1/jobs/{uuid4()}/definition", json=body)

    assert response.status_code == 422


def test_replace_definition_omitting_id_creates_a_new_operation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`id` is optional per operation -- its absence must not be a schema error."""

    definition = make_definition()
    stub(monkeypatch, "replace_definition", DefinitionReplaced(definition=definition))

    response = definition_client().put(
        f"/api/v1/jobs/{definition.job.id}/definition", json=replace_body(operation_id=None)
    )

    assert response.status_code == 200


# -- service structural invariants -----------------------------------------------------------
# The stubbed router tests above cannot exercise real SQL. These assert, at the source level,
# invariants a live database would otherwise be needed to check -- the same substitute this
# repository already uses in test_jobs_api.py for db.refresh() and order_by(Operation.position).


def test_create_definition_marks_its_edges_as_builder_sequence() -> None:
    source = inspect.getsource(definitions_service.JobDefinitionService._sequence_edges)
    assert 'origin="builder_sequence"' in source


def test_replace_definition_locks_the_job_row() -> None:
    """Concurrent replaces of the same job must not interleave. See the ticket's 'Lock and load'."""

    source = inspect.getsource(definitions_service.JobDefinitionService.replace_definition)
    assert "with_for_update()" in source


def test_replace_definition_never_deletes_external_edges() -> None:
    source = inspect.getsource(definitions_service.JobDefinitionService.replace_definition)
    assert 'Dependency.origin == "builder_sequence"' in source


def test_replace_definition_checks_scheduled_before_writing_anything() -> None:
    """The 409 check, and both validation checks, must run before any attribute is mutated."""

    source = inspect.getsource(definitions_service.JobDefinitionService.replace_definition)
    scheduled_check = source.index("JobDefinitionIsScheduled")
    first_write = source.index("job.name =")
    assert scheduled_check < first_write


def test_load_definition_uses_bulk_queries_not_lazy_relationships() -> None:
    """Never `Compatibility.operation`/`.machine` traversed lazily in async code, per the ticket."""

    source = inspect.getsource(definitions_service.JobDefinitionService._load_operations_by_job)
    assert "Operation.job_id.in_(" in source
    assert "Compatibility.operation_id.in_(" in source


def test_definition_page_is_a_dataclass_the_service_module_owns() -> None:
    """Guards against the domain page type drifting back into the HTTP layer's schemas module."""

    assert DefinitionPage.__module__ == definitions_service.__name__
