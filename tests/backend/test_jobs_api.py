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
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.user import User
from floorsync_common.jobs import service as job_service
from floorsync_common.jobs.results import (
    JobDeleted,
    JobFound,
    JobIsScheduled,
    JobNotFound,
    JobUpdated,
)
from floorsync_common.jobs.service import JobPage
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


def make_job(name: str = "Repair conveyor", priority: str = "med") -> Job:
    return Job(
        id=uuid4(), name=name, priority=priority, created_at=CREATED_AT, updated_at=CREATED_AT
    )


def make_operation(job_id: UUID, name: str = "Op00") -> Operation:
    return Operation(
        id=uuid4(),
        job_id=job_id,
        name=name,
        created_at=CREATED_AT,
        updated_at=CREATED_AT,
    )


def job_client(role: str = "manager") -> TestClient:
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

    monkeypatch.setattr(job_service.JobService, method, staticmethod(fake))


def test_create_job_returns_201_with_a_location_header(monkeypatch: pytest.MonkeyPatch) -> None:
    job = make_job()
    stub(monkeypatch, "create_job", job)

    response = job_client().post("/api/v1/jobs", json={"name": "Repair conveyor"})

    assert response.status_code == 201
    assert response.headers["Location"] == f"/api/v1/jobs/{job.id}"
    assert response.json()["name"] == "Repair conveyor"


def test_create_job_reports_its_database_default_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nothing yet lets a caller set priority; a job created today gets the database's default."""

    stub(monkeypatch, "create_job", make_job())

    response = job_client().post("/api/v1/jobs", json={"name": "Repair conveyor"})

    assert response.json()["priority"] == "med"


def test_create_job_allows_a_duplicate_name(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two real jobs can carry the same description, so names are deliberately not unique."""

    stub(monkeypatch, "create_job", make_job("Repair conveyor"))

    response = job_client().post("/api/v1/jobs", json={"name": "Repair conveyor"})

    assert response.status_code == 201


def test_create_job_rejects_a_blank_name() -> None:
    response = job_client().post("/api/v1/jobs", json={"name": "   "})

    assert response.status_code == 422


def test_create_job_rejects_unknown_fields() -> None:
    """`priority` is not in the schema; silently dropping it would look like it had been saved."""

    response = job_client().post(
        "/api/v1/jobs",
        json={"name": "Repair conveyor", "priority": "High"},
    )

    assert response.status_code == 422


def test_get_job_includes_its_operations(monkeypatch: pytest.MonkeyPatch) -> None:
    job = make_job()
    operations = (make_operation(job.id, "Op00"), make_operation(job.id, "Op01"))
    stub(monkeypatch, "get_job", JobFound(job=job, operations=operations))

    response = job_client().get(f"/api/v1/jobs/{job.id}")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(job.id)
    assert [operation["name"] for operation in body["operations"]] == ["Op00", "Op01"]


def test_get_job_orders_operations_by_position() -> None:
    """Reads must sort by position, not name: #234 moved display order off the operation name."""

    import inspect

    assert "order_by(Operation.position)" in inspect.getsource(job_service.JobService.get_job)


def test_get_job_returns_404_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    stub(monkeypatch, "get_job", JobNotFound(job_id=job_id))

    response = job_client().get(f"/api/v1/jobs/{job_id}")

    assert response.status_code == 404


def test_list_jobs_returns_a_cursor_page(monkeypatch: pytest.MonkeyPatch) -> None:
    job = make_job()
    stub(monkeypatch, "list_jobs", JobPage(jobs=(job,), next_cursor="abc"))

    response = job_client().get("/api/v1/jobs")

    assert response.status_code == 200
    body = response.json()
    assert body["next_cursor"] == "abc"
    assert [item["id"] for item in body["items"]] == [str(job.id)]


def test_list_jobs_rejects_an_out_of_range_limit() -> None:
    response = job_client().get("/api/v1/jobs", params={"limit": 500})

    assert response.status_code == 422


def test_update_job_renames_it(monkeypatch: pytest.MonkeyPatch) -> None:
    job = make_job("Repair conveyor belt")
    stub(monkeypatch, "update_job", JobUpdated(job=job))

    response = job_client().patch(
        f"/api/v1/jobs/{job.id}",
        json={"name": "Repair conveyor belt"},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "Repair conveyor belt"


def test_update_job_returns_404_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    stub(monkeypatch, "update_job", JobNotFound(job_id=job_id))

    response = job_client().patch(f"/api/v1/jobs/{job_id}", json={"name": "Anything"})

    assert response.status_code == 404


def test_update_job_rejects_an_explicit_null_name() -> None:
    """`name` is NOT NULL, so clearing it is refused before the database sees it."""

    response = job_client().patch(f"/api/v1/jobs/{uuid4()}", json={"name": None})

    assert response.status_code == 422


def test_delete_job_returns_204(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    stub(monkeypatch, "delete_job", JobDeleted(job_id=job_id))

    response = job_client().delete(f"/api/v1/jobs/{job_id}")

    assert response.status_code == 204
    assert response.content == b""


def test_delete_job_returns_404_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    stub(monkeypatch, "delete_job", JobNotFound(job_id=job_id))

    response = job_client().delete(f"/api/v1/jobs/{job_id}")

    assert response.status_code == 404


def test_delete_job_refuses_when_its_work_is_scheduled(monkeypatch: pytest.MonkeyPatch) -> None:
    """A schedule records what was planned; deleting the job would destroy that history."""

    job_id = uuid4()
    stub(monkeypatch, "delete_job", JobIsScheduled(job_id=job_id))

    response = job_client().delete(f"/api/v1/jobs/{job_id}")

    assert response.status_code == 409
    assert response.json()["type"] == "urn:floorsync:problem:job-is-scheduled"


def test_jobs_are_manager_only() -> None:
    response = job_client(role="operator").get("/api/v1/jobs")

    assert response.status_code == 403


def test_update_job_refreshes_database_computed_columns() -> None:
    """`updated_at` is filled by `onupdate`, so an UPDATE expires it.

    Serialising the row afterwards would trigger a lazy reload that async SQLAlchemy cannot await,
    surfacing as a 500. Only a live database reproduces it, so this asserts the fix is still there.
    """

    import inspect

    assert "await db.refresh(" in inspect.getsource(job_service.JobService.update_job)
