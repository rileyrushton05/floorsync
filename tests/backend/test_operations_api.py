from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import cast
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.user import User
from floorsync_common.jobs.results import JobNotFound
from floorsync_common.operations import service as operation_service
from floorsync_common.operations.results import (
    DependencyCycle,
    JobDependenciesListed,
    JobDependenciesReplaced,
    OperationCreated,
    OperationDeleted,
    OperationFound,
    OperationIsScheduled,
    OperationNotFound,
    OperationNotInJob,
    OperationUpdated,
)
from floorsync_common.operations.service import find_dependency_cycle
from floorsync_common.scheduling.references import ScheduleReferences
from floorsync_common.settings import Settings

CREATED_AT = datetime(2026, 9, 11, 8, tzinfo=UTC)


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_: object) -> None:
        return None


class FakeSession:
    """The service layer is stubbed per test, so the session only has to open a transaction."""

    def begin(self) -> FakeTransaction:
        return FakeTransaction()


def make_operation(job_id: UUID | None = None, name: str = "Cut to length") -> Operation:
    return Operation(
        id=uuid4(),
        job_id=job_id or uuid4(),
        name=name,
        created_at=CREATED_AT,
        updated_at=CREATED_AT,
    )


def make_dependency(before_operation_id: UUID, after_operation_id: UUID) -> Dependency:
    return Dependency(
        id=uuid4(),
        before_operation_id=before_operation_id,
        after_operation_id=after_operation_id,
        created_at=CREATED_AT,
        updated_at=CREATED_AT,
    )


def operation_client(role: str = "manager") -> TestClient:
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
    """Replace one operation-service call with a fixed outcome, so the route's mapping is tested."""

    async def fake(*_: object, **__: object) -> object:
        return outcome

    monkeypatch.setattr(operation_service.OperationService, method, staticmethod(fake))


def stub_ordering(monkeypatch: pytest.MonkeyPatch, method: str, outcome: object) -> None:
    """Replace one dependency-service call with a fixed outcome."""

    async def fake(*_: object, **__: object) -> object:
        return outcome

    monkeypatch.setattr(operation_service.DependencyService, method, staticmethod(fake))


def test_create_operation_returns_201_with_a_location_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    operation = make_operation()
    stub(monkeypatch, "create_operation", OperationCreated(operation=operation))

    response = operation_client().post(
        f"/api/v1/jobs/{operation.job_id}/operations",
        json={"name": "Cut to length"},
    )

    assert response.status_code == 201
    assert response.headers["Location"] == f"/api/v1/operations/{operation.id}"
    assert response.json()["name"] == "Cut to length"


def test_create_operation_returns_404_when_the_job_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An operation cannot be saved without a parent job."""

    job_id = uuid4()
    stub(monkeypatch, "create_operation", JobNotFound(job_id=job_id))

    response = operation_client().post(
        f"/api/v1/jobs/{job_id}/operations",
        json={"name": "Cut to length"},
    )

    assert response.status_code == 404


def test_create_operation_rejects_a_blank_name() -> None:
    response = operation_client().post(
        f"/api/v1/jobs/{uuid4()}/operations",
        json={"name": "   "},
    )

    assert response.status_code == 422


def test_create_operation_rejects_a_duration_field() -> None:
    """Duration is machine-dependent and lives on the capability, so it is not a field here."""

    response = operation_client().post(
        f"/api/v1/jobs/{uuid4()}/operations",
        json={"name": "Cut to length", "duration": 30},
    )

    assert response.status_code == 422


def test_get_operation_includes_its_machine_options_and_its_place_in_the_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    operation = make_operation()
    machine_id = uuid4()
    predecessor_id = uuid4()
    successor_id = uuid4()
    stub(
        monkeypatch,
        "get_operation",
        OperationFound(
            operation=operation,
            compatibilities=(
                Compatibility(
                    operation_id=operation.id,
                    machine_id=machine_id,
                    duration=30,
                    energy=None,
                ),
            ),
            predecessors=(make_dependency(predecessor_id, operation.id),),
            successors=(make_dependency(operation.id, successor_id),),
        ),
    )

    response = operation_client().get(f"/api/v1/operations/{operation.id}")

    assert response.status_code == 200
    body = response.json()
    assert body["compatibilities"] == [
        {"machine_id": str(machine_id), "duration": 30, "energy": None}
    ]
    assert body["predecessors"] == [str(predecessor_id)]
    assert body["successors"] == [str(successor_id)]


def test_get_operation_returns_404_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    operation_id = uuid4()
    stub(monkeypatch, "get_operation", OperationNotFound(operation_id=operation_id))

    response = operation_client().get(f"/api/v1/operations/{operation_id}")

    assert response.status_code == 404


def test_update_operation_renames_it(monkeypatch: pytest.MonkeyPatch) -> None:
    operation = make_operation(name="Cut to final length")
    stub(monkeypatch, "update_operation", OperationUpdated(operation=operation))

    response = operation_client().patch(
        f"/api/v1/operations/{operation.id}",
        json={"name": "Cut to final length"},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "Cut to final length"


def test_update_operation_returns_404_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    operation_id = uuid4()
    stub(monkeypatch, "update_operation", OperationNotFound(operation_id=operation_id))

    response = operation_client().patch(
        f"/api/v1/operations/{operation_id}",
        json={"name": "Anything"},
    )

    assert response.status_code == 404


def test_update_operation_rejects_an_explicit_null_name() -> None:
    """`name` is NOT NULL, so clearing it is refused before the database sees it."""

    response = operation_client().patch(f"/api/v1/operations/{uuid4()}", json={"name": None})

    assert response.status_code == 422


def test_delete_operation_returns_204(monkeypatch: pytest.MonkeyPatch) -> None:
    operation_id = uuid4()
    stub(monkeypatch, "delete_operation", OperationDeleted(operation_id=operation_id))

    response = operation_client().delete(f"/api/v1/operations/{operation_id}")

    assert response.status_code == 204
    assert response.content == b""


def test_delete_operation_returns_404_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    operation_id = uuid4()
    stub(monkeypatch, "delete_operation", OperationNotFound(operation_id=operation_id))

    response = operation_client().delete(f"/api/v1/operations/{operation_id}")

    assert response.status_code == 404


def test_delete_operation_refuses_when_it_is_scheduled(monkeypatch: pytest.MonkeyPatch) -> None:
    """A schedule records what was planned; deleting the step would destroy that history."""

    operation_id, draft_id = uuid4(), uuid4()
    stub(
        monkeypatch,
        "delete_operation",
        OperationIsScheduled(
            operation_id=operation_id,
            references=ScheduleReferences(
                draft_schedule_ids=(draft_id,), confirmed_schedule_ids=()
            ),
        ),
    )

    response = operation_client().delete(f"/api/v1/operations/{operation_id}")

    assert response.status_code == 409
    body = response.json()
    assert body["type"] == "urn:floorsync:problem:operation-is-scheduled"
    assert body["draft_schedule_ids"] == [str(draft_id)]
    assert body["confirmed_schedule_ids"] == []


def test_operations_are_manager_only() -> None:
    response = operation_client(role="operator").get(f"/api/v1/operations/{uuid4()}")

    assert response.status_code == 403


def test_list_job_dependencies_returns_the_saved_order(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    before_id, after_id = uuid4(), uuid4()
    stub_ordering(
        monkeypatch,
        "list_job_dependencies",
        JobDependenciesListed(dependencies=(make_dependency(before_id, after_id),)),
    )

    response = operation_client().get(f"/api/v1/jobs/{job_id}/dependencies")

    assert response.status_code == 200
    assert response.json()["edges"] == [
        {"before_operation_id": str(before_id), "after_operation_id": str(after_id)}
    ]


def test_list_job_dependencies_returns_404_when_the_job_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = uuid4()
    stub_ordering(monkeypatch, "list_job_dependencies", JobNotFound(job_id=job_id))

    response = operation_client().get(f"/api/v1/jobs/{job_id}/dependencies")

    assert response.status_code == 404


def test_replace_job_dependencies_accepts_multiple_predecessors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An operation can wait on more than one predecessor, which a position column cannot say."""

    job_id = uuid4()
    weld_id, paint_id, assemble_id = uuid4(), uuid4(), uuid4()
    stub_ordering(
        monkeypatch,
        "replace_job_dependencies",
        JobDependenciesReplaced(
            dependencies=(
                make_dependency(weld_id, assemble_id),
                make_dependency(paint_id, assemble_id),
            )
        ),
    )

    response = operation_client().put(
        f"/api/v1/jobs/{job_id}/dependencies",
        json={
            "edges": [
                {"before_operation_id": str(weld_id), "after_operation_id": str(assemble_id)},
                {"before_operation_id": str(paint_id), "after_operation_id": str(assemble_id)},
            ]
        },
    )

    assert response.status_code == 200
    assert [edge["before_operation_id"] for edge in response.json()["edges"]] == [
        str(weld_id),
        str(paint_id),
    ]


def test_replace_job_dependencies_clears_the_order_with_an_empty_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stub_ordering(
        monkeypatch,
        "replace_job_dependencies",
        JobDependenciesReplaced(dependencies=()),
    )

    response = operation_client().put(
        f"/api/v1/jobs/{uuid4()}/dependencies",
        json={"edges": []},
    )

    assert response.status_code == 200
    assert response.json()["edges"] == []


def test_replace_job_dependencies_rejects_a_self_edge() -> None:
    """Mirrors the `not_self_referential` constraint, so the caller gets a reason not a 500."""

    operation_id = uuid4()

    response = operation_client().put(
        f"/api/v1/jobs/{uuid4()}/dependencies",
        json={
            "edges": [
                {"before_operation_id": str(operation_id), "after_operation_id": str(operation_id)}
            ]
        },
    )

    assert response.status_code == 422


def test_replace_job_dependencies_rejects_a_repeated_edge() -> None:
    """Mirrors the uniqueness of (before_operation_id, after_operation_id) on `dependencies`."""

    before_id, after_id = uuid4(), uuid4()
    edge = {"before_operation_id": str(before_id), "after_operation_id": str(after_id)}

    response = operation_client().put(
        f"/api/v1/jobs/{uuid4()}/dependencies",
        json={"edges": [edge, edge]},
    )

    assert response.status_code == 422


def test_replace_job_dependencies_returns_404_when_the_job_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = uuid4()
    stub_ordering(monkeypatch, "replace_job_dependencies", JobNotFound(job_id=job_id))

    response = operation_client().put(f"/api/v1/jobs/{job_id}/dependencies", json={"edges": []})

    assert response.status_code == 404


def test_replace_job_dependencies_refuses_to_order_another_jobs_operation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A job owns what its own steps wait on, so it cannot set another job's ordering."""

    job_id, operation_id = uuid4(), uuid4()
    stub_ordering(
        monkeypatch,
        "replace_job_dependencies",
        OperationNotInJob(operation_id=operation_id, job_id=job_id),
    )

    response = operation_client().put(f"/api/v1/jobs/{job_id}/dependencies", json={"edges": []})

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:operation-not-in-job"


def test_replace_job_dependencies_reports_an_unknown_predecessor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A body field naming an operation that does not exist is unprocessable, not a missing page."""

    operation_id = uuid4()
    stub_ordering(
        monkeypatch,
        "replace_job_dependencies",
        OperationNotFound(operation_id=operation_id),
    )

    response = operation_client().put(f"/api/v1/jobs/{uuid4()}/dependencies", json={"edges": []})

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:operation-not-found"


def test_replace_job_dependencies_rejects_a_cycle(monkeypatch: pytest.MonkeyPatch) -> None:
    """A cyclic ordering describes work that could never start, and names who is caught in it."""

    first_id, second_id = uuid4(), uuid4()
    stub_ordering(
        monkeypatch,
        "replace_job_dependencies",
        DependencyCycle(operation_ids=(first_id, second_id)),
    )

    response = operation_client().put(f"/api/v1/jobs/{uuid4()}/dependencies", json={"edges": []})

    assert response.status_code == 422
    body = response.json()
    assert body["type"] == "urn:floorsync:problem:dependency-cycle"
    assert set(body["operation_ids"]) == {str(first_id), str(second_id)}


def test_find_dependency_cycle_accepts_a_straight_chain() -> None:
    first, second, third = uuid4(), uuid4(), uuid4()

    assert find_dependency_cycle([(first, second), (second, third)]) == ()


def test_find_dependency_cycle_accepts_fan_in_and_fan_out() -> None:
    """Two steps feeding one, and one step feeding two, are both acyclic."""

    weld, paint, assemble, inspect_, pack = uuid4(), uuid4(), uuid4(), uuid4(), uuid4()

    edges = [(weld, assemble), (paint, assemble), (assemble, inspect_), (assemble, pack)]

    assert find_dependency_cycle(edges) == ()


def test_find_dependency_cycle_names_every_operation_in_the_loop() -> None:
    first, second, third = uuid4(), uuid4(), uuid4()

    cycle = find_dependency_cycle([(first, second), (second, third), (third, first)])

    assert set(cycle) == {first, second, third}


def test_find_dependency_cycle_ignores_operations_outside_the_loop() -> None:
    """Only the operations that can never start are reported, not the whole graph."""

    stuck_first, stuck_second, clear = uuid4(), uuid4(), uuid4()

    cycle = find_dependency_cycle(
        [(stuck_first, stuck_second), (stuck_second, stuck_first), (clear, stuck_first)]
    )

    assert set(cycle) == {stuck_first, stuck_second}


def test_find_dependency_cycle_spans_jobs() -> None:
    """Cross-job edges are allowed deliberately, so a cycle can run through two jobs.

    Checking one job's slice in isolation would see two acyclic halves and store an ordering that
    can never run.
    """

    job_one_step, job_two_step = uuid4(), uuid4()

    cycle = find_dependency_cycle([(job_one_step, job_two_step), (job_two_step, job_one_step)])

    assert set(cycle) == {job_one_step, job_two_step}


def test_find_dependency_cycle_treats_an_empty_ordering_as_acyclic() -> None:
    assert find_dependency_cycle([]) == ()
