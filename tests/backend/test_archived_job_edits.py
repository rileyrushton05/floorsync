"""An archived job is read-only (decision 0018, #265).

Two layers. The services refuse every write that changes what a job is, before touching anything,
and accept the one write that brings it back. The routes turn that refusal into the one 409 the
jobs page reports.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.user import User
from floorsync_common.jobs import definitions as definitions_service
from floorsync_common.jobs import service as job_service
from floorsync_common.jobs.definitions import (
    BuilderOperationReplace,
    BuilderRoute,
    JobDefinitionReplaceCommand,
    JobDefinitionService,
)
from floorsync_common.jobs.results import JobIsArchived, JobUpdated
from floorsync_common.operations import service as operation_service
from floorsync_common.operations.service import (
    DependencyEdge,
    DependencyService,
    OperationService,
)
from floorsync_common.partial import UNSET
from floorsync_common.settings import Settings

ARCHIVED_AT = datetime(2026, 9, 17, 9, tzinfo=UTC)
PROBLEM_TYPE = "urn:floorsync:problem:job-is-archived"


def _job(archived: bool = True) -> Job:
    return Job(
        id=uuid4(),
        name="Repair conveyor",
        priority="med",
        archived_at=ARCHIVED_AT if archived else None,
        created_at=ARCHIVED_AT,
        updated_at=ARCHIVED_AT,
    )


def _operation(job: Job) -> Operation:
    return Operation(
        id=uuid4(),
        job_id=job.id,
        name="Inspect rollers",
        position=1,
        created_at=ARCHIVED_AT,
        updated_at=ARCHIVED_AT,
    )


class FakeSession:
    """Serve the job and operation by identity; refuse to write anything.

    A refusal must come before the first write, so every mutating call raises. The two passing
    cases below opt in to `flush`/`refresh` explicitly.
    """

    def __init__(self, *rows: Any, writable: bool = False) -> None:
        self.rows = {(type(row), row.id): row for row in rows}
        self.writable = writable
        self.flushes = 0

    async def get(self, model: type, identity: UUID) -> Any:
        return self.rows.get((model, identity))

    async def scalar(self, statement: Any) -> Any:
        assert "FROM jobs" in str(statement) and "FOR UPDATE" in str(statement)
        jobs = [row for (model, _), row in self.rows.items() if model is Job]
        return jobs[0] if jobs else None

    async def scalars(self, statement: Any) -> Any:
        raise AssertionError(f"Read past the archived guard: {statement}")

    async def execute(self, statement: Any) -> Any:
        raise AssertionError(f"Read past the archived guard: {statement}")

    def add(self, item: Any) -> None:
        raise AssertionError("An archived job must not be written to")

    async def delete(self, item: Any) -> None:
        raise AssertionError("An archived job must not be written to")

    async def flush(self) -> None:
        assert self.writable, "An archived job must not be written to"
        self.flushes += 1

    async def refresh(self, item: Any) -> None:
        assert self.writable


def _run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def _session(fake: FakeSession) -> AsyncSession:
    return cast(AsyncSession, fake)


# -- services refuse -------------------------------------------------------------------------


def _refusal(result: Any, job: Job) -> None:
    assert result == JobIsArchived(job_id=job.id, archived_at=ARCHIVED_AT)


def test_renaming_an_archived_job_is_refused() -> None:
    job = _job()

    result = _run(job_service.JobService.update_job(_session(FakeSession(job)), job.id, name="X"))

    _refusal(result, job)


def test_unarchiving_is_accepted_with_other_fields_in_the_same_request() -> None:
    """The job leaves the archive in the same transaction, so nothing frozen is being edited."""

    job = _job()
    fake = FakeSession(job, writable=True)

    result = _run(
        job_service.JobService.update_job(
            _session(fake), job.id, name="Repair conveyor v2", archived=False
        )
    )

    assert isinstance(result, JobUpdated)
    assert job.archived_at is None
    assert job.name == "Repair conveyor v2"
    assert fake.flushes == 1


def test_archiving_an_archived_job_again_is_still_idempotent() -> None:
    """A repeated archive request is not an edit, and the original stamp survives."""

    job = _job()
    fake = FakeSession(job, writable=True)

    result = _run(job_service.JobService.update_job(_session(fake), job.id, archived=True))

    assert isinstance(result, JobUpdated)
    assert job.archived_at == ARCHIVED_AT


def test_replacing_an_archived_definition_is_refused_before_any_read() -> None:
    job = _job()
    command = JobDefinitionReplaceCommand(
        name="Repair conveyor",
        priority="low",
        operations=(
            BuilderOperationReplace(
                id=None,
                name="Inspect rollers",
                routes=(BuilderRoute(machine_id=uuid4(), duration_minutes=45, energy=None),),
            ),
        ),
    )

    result = _run(
        JobDefinitionService.replace_definition(_session(FakeSession(job)), job.id, command)
    )

    _refusal(result, job)


def test_adding_an_operation_to_an_archived_job_is_refused() -> None:
    job = _job()

    result = _run(OperationService.create_operation(_session(FakeSession(job)), job.id, name="Cut"))

    _refusal(result, job)


def test_renaming_an_operation_of_an_archived_job_is_refused() -> None:
    job = _job()
    operation = _operation(job)

    result = _run(
        OperationService.update_operation(
            _session(FakeSession(job, operation)), operation.id, name="Cut"
        )
    )

    _refusal(result, job)


def test_removing_an_operation_from_an_archived_job_is_refused() -> None:
    job = _job()
    operation = _operation(job)

    result = _run(
        OperationService.delete_operation(_session(FakeSession(job, operation)), operation.id)
    )

    _refusal(result, job)


def test_reordering_an_archived_job_is_refused() -> None:
    job = _job()

    result = _run(
        DependencyService.replace_job_dependencies(
            _session(FakeSession(job)),
            job.id,
            edges=[DependencyEdge(before_operation_id=uuid4(), after_operation_id=uuid4())],
        )
    )

    _refusal(result, job)


def test_an_open_job_is_not_touched_by_the_guard() -> None:
    """The guard reads `archived_at` and nothing else, so an open job goes on to the real checks
    (which this fake refuses, proving the guard let it through)."""

    job = _job(archived=False)

    with pytest.raises(AssertionError, match="Read past the archived guard"):
        _run(
            DependencyService.replace_job_dependencies(_session(FakeSession(job)), job.id, edges=[])
        )


def test_every_write_path_declares_the_refusal_in_its_result_union() -> None:
    """The routers match exhaustively, so a path that forgot the outcome would not type-check;
    this pins the list of paths decision 0018 covers."""

    from floorsync_common.jobs import definition_results, results
    from floorsync_common.operations import results as operation_results

    for union in (
        results.UpdateJobResult,
        definition_results.ReplaceDefinitionResult,
        operation_results.CreateOperationResult,
        operation_results.UpdateOperationResult,
        operation_results.DeleteOperationResult,
        operation_results.ReplaceJobDependenciesResult,
    ):
        assert JobIsArchived in union.__value__.__args__, union


# -- routes answer 409 -----------------------------------------------------------------------


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_: object) -> None:
        return None


class RouteSession:
    """The service is stubbed per test, so the session only has to open a transaction."""

    def begin(self) -> FakeTransaction:
        return FakeTransaction()


def _client() -> TestClient:
    from floorsync_api.main import create_application

    application = create_application(Settings(environment="test"))
    user = User(id=uuid4(), name="Ada Manager", role="manager", machine_id=None)

    async def get_test_db_session() -> AsyncIterator[AsyncSession]:
        yield cast(AsyncSession, RouteSession())

    async def get_test_current_user() -> User:
        return user

    application.dependency_overrides[get_db_session] = get_test_db_session
    application.dependency_overrides[get_current_user] = get_test_current_user
    return TestClient(application)


def _assert_problem(response: Any, job_id: UUID) -> None:
    assert response.status_code == 409
    body = response.json()
    assert body["type"] == PROBLEM_TYPE
    assert body["job_id"] == str(job_id)
    assert datetime.fromisoformat(body["archived_at"]) == ARCHIVED_AT
    assert "archived: false" in body["detail"]


def _stub(monkeypatch: pytest.MonkeyPatch, target: Any, method: str, job_id: UUID) -> None:
    async def fake(*_: object, **__: object) -> JobIsArchived:
        return JobIsArchived(job_id=job_id, archived_at=ARCHIVED_AT)

    monkeypatch.setattr(target, method, staticmethod(fake))


def test_patch_job_reports_the_archived_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    _stub(monkeypatch, job_service.JobService, "update_job", job_id)

    response = _client().patch(f"/api/v1/jobs/{job_id}", json={"name": "X"})

    _assert_problem(response, job_id)


def test_put_definition_reports_the_archived_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    _stub(monkeypatch, definitions_service.JobDefinitionService, "replace_definition", job_id)

    response = _client().put(
        f"/api/v1/jobs/{job_id}/definition",
        json={
            "name": "X",
            "priority": "low",
            "operations": [
                {
                    "name": "Inspect rollers",
                    "routes": [
                        {"machine_id": str(uuid4()), "duration_minutes": 45, "energy": "1.25"}
                    ],
                }
            ],
        },
    )

    _assert_problem(response, job_id)


def test_post_operation_reports_the_archived_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    _stub(monkeypatch, operation_service.OperationService, "create_operation", job_id)

    response = _client().post(f"/api/v1/jobs/{job_id}/operations", json={"name": "Cut"})

    _assert_problem(response, job_id)


def test_patch_operation_reports_the_archived_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    _stub(monkeypatch, operation_service.OperationService, "update_operation", job_id)

    response = _client().patch(f"/api/v1/operations/{uuid4()}", json={"name": "Cut"})

    _assert_problem(response, job_id)


def test_delete_operation_reports_the_archived_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    _stub(monkeypatch, operation_service.OperationService, "delete_operation", job_id)

    response = _client().delete(f"/api/v1/operations/{uuid4()}")

    _assert_problem(response, job_id)


def test_put_dependencies_reports_the_archived_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    _stub(monkeypatch, operation_service.DependencyService, "replace_job_dependencies", job_id)

    response = _client().put(f"/api/v1/jobs/{job_id}/dependencies", json={"edges": []})

    _assert_problem(response, job_id)


def test_the_partial_marker_is_what_the_guard_compares_against() -> None:
    """`update_job` must treat an omitted `archived` as "not unarchiving", not as False."""

    job = _job()

    result = _run(
        job_service.JobService.update_job(
            _session(FakeSession(job)), job.id, name="X", archived=UNSET
        )
    )

    _refusal(result, job)
