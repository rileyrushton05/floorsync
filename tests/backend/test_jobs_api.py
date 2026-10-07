from collections.abc import AsyncIterator, Collection
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
from floorsync_common.jobs import backlog
from floorsync_common.jobs import service as job_service
from floorsync_common.jobs.backlog import OPEN, JobBacklog
from floorsync_common.jobs.results import (
    JobDeleted,
    JobFound,
    JobIsScheduled,
    JobNotFound,
    JobUpdated,
)
from floorsync_common.jobs.service import JobDependencyGraph, JobPage
from floorsync_common.scheduling.references import ScheduleReferences
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


@pytest.fixture(autouse=True)
def every_job_is_open(monkeypatch: pytest.MonkeyPatch) -> None:
    """Routes read backlog status through `BacklogService` after the service call they test;
    answer `open` for every job here so each test stays about its own route (decision 0019)."""

    async def fake(_: object, jobs: Collection[Job]) -> dict[UUID, JobBacklog]:
        return {job.id: OPEN for job in jobs}

    monkeypatch.setattr(backlog.BacklogService, "load", staticmethod(fake))


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


def test_dependency_graph_maps_each_edge(monkeypatch: pytest.MonkeyPatch) -> None:
    before, after = uuid4(), uuid4()
    stub(monkeypatch, "list_dependency_graph", JobDependencyGraph(edges=((before, after),)))

    response = job_client().get("/api/v1/jobs/dependency-graph")

    assert response.status_code == 200
    assert response.json() == {
        "edges": [{"before_job_id": str(before), "after_job_id": str(after)}]
    }


def test_dependency_graph_is_an_empty_list_when_no_job_waits_on_another(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stub(monkeypatch, "list_dependency_graph", JobDependencyGraph(edges=()))

    response = job_client().get("/api/v1/jobs/dependency-graph")

    assert response.status_code == 200
    assert response.json() == {"edges": []}


def test_dependency_graph_is_not_read_as_a_job_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Declared before `/{job_id}`; the other way round this path is refused as a malformed UUID."""

    stub(monkeypatch, "list_dependency_graph", JobDependencyGraph(edges=()))

    response = job_client().get("/api/v1/jobs/dependency-graph")

    assert response.status_code != 422


def test_dependency_graph_requires_a_manager(monkeypatch: pytest.MonkeyPatch) -> None:
    stub(monkeypatch, "list_dependency_graph", JobDependencyGraph(edges=()))

    response = job_client(role="operator").get("/api/v1/jobs/dependency-graph")

    assert response.status_code == 403


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


def test_update_job_passes_archived_through_and_reports_archived_at(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`archived` is a boolean on the wire; the row records when, and the response reports that."""

    job = make_job()
    job.archived_at = CREATED_AT
    received: dict[str, object] = {}

    async def fake(_: object, job_id: UUID, **kwargs: object) -> JobUpdated:
        received.update(kwargs)
        return JobUpdated(job=job)

    monkeypatch.setattr(job_service.JobService, "update_job", staticmethod(fake))

    response = job_client().patch(f"/api/v1/jobs/{job.id}", json={"archived": True})

    assert response.status_code == 200
    assert received["archived"] is True
    assert datetime.fromisoformat(response.json()["archived_at"]) == CREATED_AT


def test_update_job_rejects_an_explicit_null_archived() -> None:
    response = job_client().patch(f"/api/v1/jobs/{uuid4()}", json={"archived": None})

    assert response.status_code == 422


def test_update_job_names_every_nulled_field_at_once() -> None:
    """Same collect-all pattern as `MachineUpdateRequest`, so one round trip reports every slip."""

    response = job_client().patch(f"/api/v1/jobs/{uuid4()}", json={"name": None, "archived": None})

    assert response.status_code == 422
    assert "name, archived cannot be null" in response.text


def test_list_jobs_hides_archived_unless_asked(monkeypatch: pytest.MonkeyPatch) -> None:
    """The list is the backlog, so archived jobs are opt-in."""

    received: list[bool] = []

    async def fake(_: object, **kwargs: object) -> JobPage:
        received.append(bool(kwargs["include_archived"]))
        return JobPage(jobs=(), next_cursor=None)

    monkeypatch.setattr(job_service.JobService, "list_jobs", staticmethod(fake))

    job_client().get("/api/v1/jobs")
    job_client().get("/api/v1/jobs", params={"include_archived": "true"})

    assert received == [False, True]


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
    """A schedule records what was planned; deleting the job would destroy that history.

    The body names the schedules split by what the caller can do about them: drafts can be deleted
    first, a confirmed schedule cannot, and the detail says which situation this is.
    """

    job_id, draft_id, confirmed_id = uuid4(), uuid4(), uuid4()
    stub(
        monkeypatch,
        "delete_job",
        JobIsScheduled(
            job_id=job_id,
            references=ScheduleReferences(
                draft_schedule_ids=(draft_id,), confirmed_schedule_ids=(confirmed_id,)
            ),
        ),
    )

    response = job_client().delete(f"/api/v1/jobs/{job_id}")

    assert response.status_code == 409
    body = response.json()
    assert body["type"] == "urn:floorsync:problem:job-is-scheduled"
    assert body["draft_schedule_ids"] == [str(draft_id)]
    assert body["confirmed_schedule_ids"] == [str(confirmed_id)]
    assert "archive the job" in body["detail"]


def test_delete_job_refusal_points_at_draft_deletion_when_only_drafts_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id, draft_id = uuid4(), uuid4()
    stub(
        monkeypatch,
        "delete_job",
        JobIsScheduled(
            job_id=job_id,
            references=ScheduleReferences(
                draft_schedule_ids=(draft_id,), confirmed_schedule_ids=()
            ),
        ),
    )

    response = job_client().delete(f"/api/v1/jobs/{job_id}")

    assert response.status_code == 409
    body = response.json()
    assert body["draft_schedule_ids"] == [str(draft_id)]
    assert body["confirmed_schedule_ids"] == []
    assert "DELETE /api/v1/schedules/{schedule_id}" in body["detail"]


def test_jobs_are_manager_only() -> None:
    response = job_client(role="operator").get("/api/v1/jobs")

    assert response.status_code == 403
