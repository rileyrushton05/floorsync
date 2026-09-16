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
    OperationHasExternalDependents,
    OperationWithRoutes,
    UnknownMachine,
)
from floorsync_common.jobs.definitions import DefinitionPage, JobDefinitionService
from floorsync_common.jobs.results import JobNotFound
from floorsync_common.operations.results import DependencyCycle
from floorsync_common.scheduling.references import ScheduleReferences
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


def test_list_definitions_hides_archived_unless_asked(monkeypatch: pytest.MonkeyPatch) -> None:
    """The builder's list is the backlog too, so it takes the same `include_archived` opt-in."""

    received: list[bool] = []

    async def fake(_: object, **kwargs: object) -> DefinitionsListed:
        received.append(bool(kwargs["include_archived"]))
        return DefinitionsListed(definitions=(), next_cursor=None)

    monkeypatch.setattr(JobDefinitionService, "list_definitions", staticmethod(fake))

    definition_client().get("/api/v1/job-definitions")
    definition_client().get("/api/v1/job-definitions", params={"include_archived": "true"})

    assert received == [False, True]


def test_list_definitions_filters_archived_in_the_query() -> None:
    """The filter lives in the service, not the route, so every caller gets the same backlog."""

    source = inspect.getsource(JobDefinitionService.list_definitions)
    assert "Job.archived_at.is_(None)" in source


def test_definition_response_reports_archived_at(monkeypatch: pytest.MonkeyPatch) -> None:
    definition = make_definition()
    definition.job.archived_at = definition.job.created_at
    stub(monkeypatch, "get_definition", DefinitionFound(definition=definition))

    response = definition_client().get(f"/api/v1/jobs/{definition.job.id}/definition")

    assert response.status_code == 200
    assert response.json()["archived_at"] is not None


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


def test_replace_definition_refuses_when_a_removed_operation_is_scheduled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The 409 names the schedules in the way, split by whether deleting them would clear it."""

    job_id, draft_id = uuid4(), uuid4()
    stub(
        monkeypatch,
        "replace_definition",
        JobDefinitionIsScheduled(
            job_id=job_id,
            references=ScheduleReferences(
                draft_schedule_ids=(draft_id,), confirmed_schedule_ids=()
            ),
        ),
    )

    response = definition_client().put(f"/api/v1/jobs/{job_id}/definition", json=replace_body())

    assert response.status_code == 409
    body = response.json()
    assert body["type"] == "urn:floorsync:problem:job_definition_is_scheduled"
    assert body["draft_schedule_ids"] == [str(draft_id)]
    assert body["confirmed_schedule_ids"] == []
    assert "removes an operation" in body["detail"]


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


def test_replace_definition_refuses_to_orphan_another_jobs_edge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Omitting an operation another job's own edge names must not silently cascade it away."""

    job_id, operation_id, other_job_id = uuid4(), uuid4(), uuid4()
    stub(
        monkeypatch,
        "replace_definition",
        OperationHasExternalDependents(operation_id=operation_id, job_id=other_job_id),
    )

    response = definition_client().put(f"/api/v1/jobs/{job_id}/definition", json=replace_body())

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:operation_has_external_dependents"


def test_replace_definition_refuses_a_reorder_that_forms_a_cycle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A reorder combined with a retained external edge must be checked for a cycle."""

    job_id = uuid4()
    stub(
        monkeypatch,
        "replace_definition",
        DependencyCycle(operation_ids=(uuid4(), uuid4())),
    )

    response = definition_client().put(f"/api/v1/jobs/{job_id}/definition", json=replace_body())

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:dependency-cycle"


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


def test_replace_definition_checks_for_orphaned_cross_job_edges() -> None:
    """Regression test: deleting an omitted operation must not cascade another job's own edge."""

    source = inspect.getsource(definitions_service.JobDefinitionService.replace_definition)
    assert "_find_external_dependent(" in source


def test_replace_definition_checks_for_a_cycle_before_writing_the_new_order() -> None:
    """Regression test: a reorder plus a retained external edge can close a loop unnoticed."""

    source = inspect.getsource(definitions_service.JobDefinitionService.replace_definition)
    assert "find_dependency_cycle(" in source


def test_replace_definition_skips_a_pair_a_retained_edge_already_covers() -> None:
    """Regression test: (before, after) is unique regardless of origin.

    An unchanged, or merely renamed, operation pair whose order already matches an existing
    external edge would otherwise re-insert that same pair as a builder_sequence row and hit the
    unique constraint -- no reorder needed to trigger it.
    """

    source = inspect.getsource(definitions_service.JobDefinitionService.replace_definition)
    assert "retained_pairs" in source
    assert "if pair not in retained_pairs" in source


def test_replace_definition_only_refuses_scheduled_operations_it_removes() -> None:
    """The 409 is scoped to removals, not to every save touching a scheduled job (#258).

    `schedule_entries` snapshots duration, energy, machine salary, machine and start time, and
    `schedule_dependencies` snapshots the graph, so an edit that keeps every operation cannot
    rewrite what a schedule recorded. Only a removal is unsafe, because
    `schedule_entries.operation_id` is ON DELETE RESTRICT. Guarding the whole save instead made a
    floor uneditable the moment one schedule had been generated over it.
    """

    source = inspect.getsource(definitions_service.JobDefinitionService.replace_definition)
    guard = source.index("JobDefinitionIsScheduled(")
    lookup = source.rindex("find_schedule_references(", 0, guard)
    assert "operation_ids=removed_ids" in source[lookup:guard], (
        "the scheduled-operation guard must look up removed_ids, not every existing operation"
    )
    assert source.index("removed_ids = ") < lookup


def test_replace_definition_checks_scheduled_before_writing_anything() -> None:
    """The 409 check, and every validation check, must run before any attribute is mutated."""

    source = inspect.getsource(definitions_service.JobDefinitionService.replace_definition)
    scheduled_check = source.index("JobDefinitionIsScheduled(")
    external_dependent_check = source.index("_find_external_dependent(")
    cycle_check = source.index("find_dependency_cycle(")
    first_write = source.index("job.name =")
    assert scheduled_check < external_dependent_check < cycle_check < first_write


def test_load_definition_uses_bulk_queries_not_lazy_relationships() -> None:
    """Never `Compatibility.operation`/`.machine` traversed lazily in async code, per the ticket."""

    source = inspect.getsource(definitions_service.JobDefinitionService._load_operations_by_job)
    assert "Operation.job_id.in_(" in source
    assert "Compatibility.operation_id.in_(" in source


def test_definition_page_is_a_dataclass_the_service_module_owns() -> None:
    """Guards against the domain page type drifting back into the HTTP layer's schemas module."""

    assert DefinitionPage.__module__ == definitions_service.__name__
