"""Backlog status is derived from the schedules that reference a job (#269, decision 0019)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Collection
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.user import User
from floorsync_common.jobs import backlog
from floorsync_common.jobs import service as job_service
from floorsync_common.jobs.backlog import (
    OPEN,
    BacklogService,
    JobBacklog,
    derive_backlog,
    planned_jobs_statement,
)
from floorsync_common.jobs.dependency_graph import job_dependency_edges_statement
from floorsync_common.jobs.results import JobFound, JobUpdated
from floorsync_common.settings import Settings

AT = datetime(2026, 9, 18, 8, tzinfo=UTC)


def _job(archived: bool = False) -> Job:
    return Job(
        id=uuid4(),
        name="Repair conveyor",
        priority="med",
        archived_at=AT if archived else None,
        created_at=AT,
        updated_at=AT,
    )


# -- derive_backlog ---------------------------------------------------------------------------


def test_a_job_nothing_plans_is_open() -> None:
    job_id = uuid4()

    assert derive_backlog([(job_id, None)], []) == {job_id: OPEN}


def test_a_job_a_confirmed_schedule_plans_is_planned_and_names_the_schedule() -> None:
    job_id, schedule_id = uuid4(), uuid4()

    result = derive_backlog([(job_id, None)], [(job_id, schedule_id, None)])

    assert result[job_id] == JobBacklog(status="planned", schedule_ids=(schedule_id,))


def test_one_row_per_operation_folds_to_one_schedule_in_plan_order() -> None:
    job_id, first, second = uuid4(), uuid4(), uuid4()
    rows = [(job_id, first, None), (job_id, first, None), (job_id, second, "not_started")]

    result = derive_backlog([(job_id, None)], rows)

    assert result[job_id] == JobBacklog(status="planned", schedule_ids=(first, second))


def test_a_completed_simulation_makes_the_job_done() -> None:
    job_id, schedule_id = uuid4(), uuid4()

    result = derive_backlog([(job_id, None)], [(job_id, schedule_id, "complete")])

    assert result[job_id].status == "done"


def test_a_running_simulation_is_still_only_planned() -> None:
    job_id = uuid4()

    result = derive_backlog([(job_id, None)], [(job_id, uuid4(), "running")])

    assert result[job_id].status == "planned"


def test_done_wins_over_planned_across_schedules() -> None:
    job_id, ran, waiting = uuid4(), uuid4(), uuid4()

    result = derive_backlog([(job_id, None)], [(job_id, ran, "complete"), (job_id, waiting, None)])

    assert result[job_id] == JobBacklog(status="done", schedule_ids=(ran, waiting))


def test_archived_is_the_managers_word_and_wins_over_everything() -> None:
    job_id, schedule_id = uuid4(), uuid4()

    result = derive_backlog([(job_id, AT)], [(job_id, schedule_id, "complete")])

    assert result[job_id] == JobBacklog(status="archived", schedule_ids=(schedule_id,))


def test_every_asked_job_gets_an_answer_and_no_other_does() -> None:
    asked, other = uuid4(), uuid4()

    result = derive_backlog([(asked, None)], [(other, uuid4(), None)])

    assert result == {asked: OPEN}


# -- statements -------------------------------------------------------------------------------


def _sql(statement: Any) -> str:
    return str(statement.compile(dialect=postgresql.dialect()))


def test_plans_come_only_from_confirmed_schedules() -> None:
    sql = _sql(planned_jobs_statement([uuid4()]))

    assert "schedules.status = " in sql
    assert "LEFT OUTER JOIN simulations" in sql
    assert "DISTINCT" not in sql, "ordering by created_at needs the repeats; derive folds them"
    assert "ORDER BY schedules.created_at" in sql


def test_the_job_dependency_graph_leaves_out_planned_jobs_on_both_ends() -> None:
    """The backlog must never auto-tick a job the scheduler would refuse as already planned."""

    sql = _sql(job_dependency_edges_statement())

    assert sql.count("NOT IN (SELECT") == 2
    assert "schedules.status = " in sql


# -- BacklogService ---------------------------------------------------------------------------


class FakeSession:
    def __init__(self, rows: list[tuple[UUID, UUID, str | None]]) -> None:
        self.rows = rows
        self.executed = 0

    async def execute(self, statement: Any) -> Any:
        self.executed += 1

        class Result:
            def tuples(self_inner) -> Any:
                return self_inner

            def all(self_inner) -> list[Any]:
                return self.rows

        return Result()


def test_the_service_reads_once_for_any_number_of_jobs() -> None:
    first, second = _job(), _job()
    fake = FakeSession([(first.id, uuid4(), None)])

    result = asyncio.run(BacklogService.load(cast(AsyncSession, fake), [first, second]))

    assert fake.executed == 1
    assert result[first.id].status == "planned"
    assert result[second.id] == OPEN


def test_the_service_does_not_read_for_no_jobs() -> None:
    fake = FakeSession([])

    assert asyncio.run(BacklogService.load(cast(AsyncSession, fake), [])) == {}
    assert fake.executed == 0


# -- routes report it ------------------------------------------------------------------------


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_: object) -> None:
        return None


class RouteSession:
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


def _planned_by(monkeypatch: pytest.MonkeyPatch, schedule_id: UUID) -> None:
    async def fake(_: object, jobs: Collection[Job]) -> dict[UUID, JobBacklog]:
        return {job.id: JobBacklog(status="planned", schedule_ids=(schedule_id,)) for job in jobs}

    monkeypatch.setattr(backlog.BacklogService, "load", staticmethod(fake))


def test_get_job_reports_backlog_status_and_the_planning_schedule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job, schedule_id = _job(), uuid4()
    _planned_by(monkeypatch, schedule_id)

    async def fake(_: object, __: UUID) -> JobFound:
        return JobFound(job=job, operations=())

    monkeypatch.setattr(job_service.JobService, "get_job", staticmethod(fake))

    body = _client().get(f"/api/v1/jobs/{job.id}").json()

    assert body["backlog_status"] == "planned"
    assert body["planned_by_schedule_ids"] == [str(schedule_id)]
    assert body["archived_at"] is None


def test_patch_job_reports_backlog_status_too(monkeypatch: pytest.MonkeyPatch) -> None:
    job, schedule_id = _job(), uuid4()
    _planned_by(monkeypatch, schedule_id)

    async def fake(_: object, __: UUID, **___: object) -> JobUpdated:
        return JobUpdated(job=job)

    monkeypatch.setattr(job_service.JobService, "update_job", staticmethod(fake))

    body = _client().patch(f"/api/v1/jobs/{job.id}", json={"name": "Renamed"}).json()

    assert body["backlog_status"] == "planned"


def test_a_created_job_is_open_without_asking(monkeypatch: pytest.MonkeyPatch) -> None:
    job = _job()

    async def create(_: object, *, name: str) -> Job:
        return job

    async def never(_: object, __: object) -> dict[UUID, JobBacklog]:
        raise AssertionError("a brand new job is in no schedule; do not read")

    monkeypatch.setattr(job_service.JobService, "create_job", staticmethod(create))
    monkeypatch.setattr(backlog.BacklogService, "load", staticmethod(never))

    response = _client().post("/api/v1/jobs", json={"name": "Repair conveyor"})

    assert response.status_code == 201
    assert response.json()["backlog_status"] == "open"
    assert response.json()["planned_by_schedule_ids"] == []
