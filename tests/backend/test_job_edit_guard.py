"""Only an open job can be changed (decisions 0018 and 0019; #265, #269).

Two layers. The services refuse every write that changes what a job is unless its backlog status
is `open`, before touching anything, and accept the one write a non-open job still takes. The
routes turn that refusal into the one 409 the jobs page reports.
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
from floorsync_common.jobs.backlog import BacklogStatus, JobBacklog
from floorsync_common.jobs.definitions import (
    BuilderOperationReplace,
    BuilderRoute,
    JobDefinitionReplaceCommand,
    JobDefinitionService,
)
from floorsync_common.jobs.results import JobHasLeftBacklog, JobUpdated
from floorsync_common.operations import service as operation_service
from floorsync_common.operations.service import (
    DependencyEdge,
    DependencyService,
    OperationService,
)
from floorsync_common.partial import UNSET
from floorsync_common.settings import Settings

AT = datetime(2026, 9, 17, 9, tzinfo=UTC)
PROBLEM_TYPE = "urn:floorsync:problem:job-has-left-backlog"


def _job(archived: bool = False) -> Job:
    return Job(
        id=uuid4(),
        name="Repair conveyor",
        priority="med",
        archived_at=AT if archived else None,
        created_at=AT,
        updated_at=AT,
    )


def _operation(job: Job) -> Operation:
    return Operation(
        id=uuid4(),
        job_id=job.id,
        name="Inspect rollers",
        position=1,
        created_at=AT,
        updated_at=AT,
    )


class FakeSession:
    """Serve the job and operation by identity, answer the one backlog read, refuse all writes.

    `plans` are the `(job_id, schedule_id, simulation_status)` rows the backlog read returns. A
    refusal must come before the first write, so every mutating call raises; the passing cases
    opt in to `flush`/`refresh` with `writable`.
    """

    def __init__(
        self,
        *rows: Any,
        plans: list[tuple[UUID, UUID, str | None]] | None = None,
        writable: bool = False,
    ) -> None:
        self.rows = {(type(row), row.id): row for row in rows}
        self.plans = plans or []
        self.writable = writable
        self.flushes = 0

    async def get(self, model: type, identity: UUID) -> Any:
        return self.rows.get((model, identity))

    async def scalar(self, statement: Any) -> Any:
        assert "FROM jobs" in str(statement) and "FOR UPDATE" in str(statement)
        jobs = [row for (model, _), row in self.rows.items() if model is Job]
        return jobs[0] if jobs else None

    async def execute(self, statement: Any) -> Any:
        rendered = str(statement)
        if "FROM schedule_entries" in rendered:
            plans = self.plans

            class Result:
                def tuples(self) -> Any:
                    return self

                def all(self) -> list[Any]:
                    return plans

            return Result()
        raise AssertionError(f"Read past the guard: {rendered}")

    async def scalars(self, statement: Any) -> Any:
        raise AssertionError(f"Read past the guard: {statement}")

    def add(self, item: Any) -> None:
        raise AssertionError("A job that has left the backlog must not be written to")

    async def delete(self, item: Any) -> None:
        raise AssertionError("A job that has left the backlog must not be written to")

    async def flush(self) -> None:
        assert self.writable, "A job that has left the backlog must not be written to"
        self.flushes += 1

    async def refresh(self, item: Any) -> None:
        assert self.writable


def _run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def _session(fake: FakeSession) -> AsyncSession:
    return cast(AsyncSession, fake)


def _planned(job: Job, schedule_id: UUID, simulation_status: str | None = None) -> FakeSession:
    return FakeSession(job, plans=[(job.id, schedule_id, simulation_status)])


# -- services refuse -------------------------------------------------------------------------


def _refusal(
    result: Any, job: Job, status: BacklogStatus, schedule_ids: tuple[UUID, ...] = ()
) -> None:
    assert result == JobHasLeftBacklog(
        job_id=job.id,
        backlog=JobBacklog(status=status, schedule_ids=schedule_ids),
        archived_at=job.archived_at,
    )


def test_renaming_an_archived_job_is_refused() -> None:
    job = _job(archived=True)

    result = _run(job_service.JobService.update_job(_session(FakeSession(job)), job.id, name="X"))

    _refusal(result, job, "archived")


def test_renaming_a_planned_job_is_refused_and_names_the_schedule() -> None:
    job, schedule_id = _job(), uuid4()

    result = _run(
        job_service.JobService.update_job(_session(_planned(job, schedule_id)), job.id, name="X")
    )

    _refusal(result, job, "planned", (schedule_id,))


def test_renaming_a_done_job_is_refused() -> None:
    job, schedule_id = _job(), uuid4()

    result = _run(
        job_service.JobService.update_job(
            _session(_planned(job, schedule_id, "complete")), job.id, name="X"
        )
    )

    _refusal(result, job, "done", (schedule_id,))


def test_archiving_a_planned_job_by_hand_is_how_a_manager_cancels_it() -> None:
    """`archived: true` is the one write a non-open job takes; it never reads the backlog."""

    job, schedule_id = _job(), uuid4()
    fake = _planned(job, schedule_id)
    fake.writable = True

    result = _run(job_service.JobService.update_job(_session(fake), job.id, archived=True))

    assert isinstance(result, JobUpdated)
    assert job.archived_at is not None
    assert fake.flushes == 1


def test_archiving_an_archived_job_again_is_still_idempotent() -> None:
    job = _job(archived=True)
    fake = FakeSession(job, writable=True)

    result = _run(job_service.JobService.update_job(_session(fake), job.id, archived=True))

    assert isinstance(result, JobUpdated)
    assert job.archived_at == AT


def test_there_is_no_way_back_through_the_service() -> None:
    """Archiving is one way (decision 0018): the service does not accept `archived=False`."""

    import inspect

    signature = inspect.signature(job_service.JobService.update_job)
    assert str(signature.parameters["archived"].annotation) == "Literal[True] | Unset"


def test_renaming_an_open_job_reads_the_backlog_once_and_passes() -> None:
    job = _job()
    fake = FakeSession(job, writable=True)

    result = _run(job_service.JobService.update_job(_session(fake), job.id, name="Renamed"))

    assert isinstance(result, JobUpdated)
    assert job.name == "Renamed"


def test_replacing_a_planned_definition_is_refused_before_any_other_read() -> None:
    job, schedule_id = _job(), uuid4()
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
        JobDefinitionService.replace_definition(
            _session(_planned(job, schedule_id)), job.id, command
        )
    )

    _refusal(result, job, "planned", (schedule_id,))


def test_adding_an_operation_to_a_planned_job_is_refused() -> None:
    job, schedule_id = _job(), uuid4()

    result = _run(
        OperationService.create_operation(_session(_planned(job, schedule_id)), job.id, name="Cut")
    )

    _refusal(result, job, "planned", (schedule_id,))


def test_renaming_an_operation_of_an_archived_job_is_refused() -> None:
    job = _job(archived=True)
    operation = _operation(job)

    result = _run(
        OperationService.update_operation(
            _session(FakeSession(job, operation)), operation.id, name="Cut"
        )
    )

    _refusal(result, job, "archived")


def test_removing_an_operation_from_a_done_job_is_refused() -> None:
    job, schedule_id = _job(), uuid4()
    operation = _operation(job)
    fake = FakeSession(job, operation, plans=[(job.id, schedule_id, "complete")])

    result = _run(OperationService.delete_operation(_session(fake), operation.id))

    _refusal(result, job, "done", (schedule_id,))


def test_reordering_a_planned_job_is_refused() -> None:
    job, schedule_id = _job(), uuid4()

    result = _run(
        DependencyService.replace_job_dependencies(
            _session(_planned(job, schedule_id)),
            job.id,
            edges=[DependencyEdge(before_operation_id=uuid4(), after_operation_id=uuid4())],
        )
    )

    _refusal(result, job, "planned", (schedule_id,))


def test_an_open_job_goes_on_to_the_real_checks() -> None:
    """The guard reads the backlog and nothing else, so an open job reaches the next read
    (which this fake refuses, proving the guard let it through)."""

    job = _job()

    with pytest.raises(AssertionError, match="Read past the guard"):
        _run(
            DependencyService.replace_job_dependencies(_session(FakeSession(job)), job.id, edges=[])
        )


def test_every_write_path_declares_the_refusal_in_its_result_union() -> None:
    """The routers match exhaustively, so a path that forgot the outcome would not type-check;
    this pins the list of paths decisions 0018 and 0019 cover."""

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
        assert JobHasLeftBacklog in union.__value__.__args__, union


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


def _assert_problem(
    response: Any, job_id: UUID, status: BacklogStatus, schedule_id: UUID | None
) -> None:
    assert response.status_code == 409
    body = response.json()
    assert body["type"] == PROBLEM_TYPE
    assert body["job_id"] == str(job_id)
    assert body["backlog_status"] == status
    assert body["planned_by_schedule_ids"] == ([] if schedule_id is None else [str(schedule_id)])
    assert "Duplicate" in body["detail"] or "duplicate" in body["detail"]


def _stub(
    monkeypatch: pytest.MonkeyPatch,
    target: Any,
    method: str,
    job_id: UUID,
    status: BacklogStatus = "planned",
    schedule_id: UUID | None = None,
) -> None:
    backlog = JobBacklog(status=status, schedule_ids=() if schedule_id is None else (schedule_id,))

    async def fake(*_: object, **__: object) -> JobHasLeftBacklog:
        return JobHasLeftBacklog(
            job_id=job_id, backlog=backlog, archived_at=AT if status == "archived" else None
        )

    monkeypatch.setattr(target, method, staticmethod(fake))


def test_patch_job_reports_the_planned_conflict_with_the_schedule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id, schedule_id = uuid4(), uuid4()
    _stub(monkeypatch, job_service.JobService, "update_job", job_id, "planned", schedule_id)

    response = _client().patch(f"/api/v1/jobs/{job_id}", json={"name": "X"})

    _assert_problem(response, job_id, "planned", schedule_id)
    assert "Discard that schedule" in response.json()["detail"]
    assert response.json()["archived_at"] is None


def test_patch_job_reports_the_archived_conflict_with_the_stamp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = uuid4()
    _stub(monkeypatch, job_service.JobService, "update_job", job_id, "archived")

    response = _client().patch(f"/api/v1/jobs/{job_id}", json={"name": "X"})

    _assert_problem(response, job_id, "archived", None)
    assert datetime.fromisoformat(response.json()["archived_at"]) == AT


def test_put_definition_reports_the_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id, schedule_id = uuid4(), uuid4()
    _stub(
        monkeypatch,
        definitions_service.JobDefinitionService,
        "replace_definition",
        job_id,
        "done",
        schedule_id,
    )

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

    _assert_problem(response, job_id, "done", schedule_id)


def test_post_operation_reports_the_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id, schedule_id = uuid4(), uuid4()
    _stub(
        monkeypatch,
        operation_service.OperationService,
        "create_operation",
        job_id,
        "planned",
        schedule_id,
    )

    response = _client().post(f"/api/v1/jobs/{job_id}/operations", json={"name": "Cut"})

    _assert_problem(response, job_id, "planned", schedule_id)


def test_patch_operation_reports_the_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = uuid4()
    _stub(monkeypatch, operation_service.OperationService, "update_operation", job_id, "archived")

    response = _client().patch(f"/api/v1/operations/{uuid4()}", json={"name": "Cut"})

    _assert_problem(response, job_id, "archived", None)


def test_delete_operation_reports_the_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id, schedule_id = uuid4(), uuid4()
    _stub(
        monkeypatch,
        operation_service.OperationService,
        "delete_operation",
        job_id,
        "planned",
        schedule_id,
    )

    response = _client().delete(f"/api/v1/operations/{uuid4()}")

    _assert_problem(response, job_id, "planned", schedule_id)


def test_put_dependencies_reports_the_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id, schedule_id = uuid4(), uuid4()
    _stub(
        monkeypatch,
        operation_service.DependencyService,
        "replace_job_dependencies",
        job_id,
        "planned",
        schedule_id,
    )

    response = _client().put(f"/api/v1/jobs/{job_id}/dependencies", json={"edges": []})

    _assert_problem(response, job_id, "planned", schedule_id)


def test_the_partial_marker_is_what_the_guard_compares_against() -> None:
    """`update_job` must treat an omitted `archived` as "no change", and still refuse the rename."""

    job = _job(archived=True)

    result = _run(
        job_service.JobService.update_job(
            _session(FakeSession(job)), job.id, name="X", archived=UNSET
        )
    )

    _refusal(result, job, "archived")


def test_the_request_schema_refuses_archived_false() -> None:
    response = _client().patch(f"/api/v1/jobs/{uuid4()}", json={"archived": False})

    assert response.status_code == 422
    assert "archived" in response.text
