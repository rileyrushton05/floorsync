"""A schedule reports the jobs its generation was asked for (#303), against a real database.

Generation writes the selection (`SchedulingService.store_draft`, in the worker's synchronous
session) and `GET /api/v1/schedules/{id}` reads it back (`ScheduleReadService`, async). The test
pushes one selection through both, so the two cannot disagree.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_api.main import application
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.schedule import SCHEDULE_DRAFT, Schedule
from floorsync_common.database.models.user import User
from floorsync_common.scheduling.contracts import ScheduleMetrics, SchedulePlan
from floorsync_common.scheduling.service import SchedulingService

STARTS_AT = datetime(2026, 10, 9, 8, tzinfo=UTC)


@pytest.fixture
def api(database_url: str) -> Iterator[TestClient]:
    """The real app, its sessions bound to the test database and its caller a signed-in manager."""
    engine = create_async_engine(database_url, poolclass=NullPool)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autobegin=False)

    async def db_session() -> AsyncIterator[AsyncSession]:
        async with sessions() as session:
            yield session

    async def manager() -> User:
        return User(id=uuid4(), name="Manager", role="manager")

    application.dependency_overrides[get_db_session] = db_session
    application.dependency_overrides[get_current_user] = manager
    try:
        yield TestClient(application)
    finally:
        application.dependency_overrides.clear()
        asyncio.run(engine.dispose())


@pytest.fixture
def worker_db(database_url: str) -> Iterator[Session]:
    """A synchronous session like the worker's, on the same test database."""
    engine = create_engine(
        make_url(database_url).set(drivername="postgresql+psycopg"), poolclass=NullPool
    )
    try:
        with Session(engine) as session:
            yield session
    finally:
        engine.dispose()


def _store_draft(db: Session, job_ids: list[UUID]) -> UUID:
    # An empty plan: a selected job with no schedulable work has no entries yet is still part of
    # the selection, so the selection must not be read from the entries.
    stored = SchedulingService.store_draft(
        db,
        plan=SchedulePlan(
            assignments=(),
            dependencies=(),
            metrics=ScheduleMetrics(makespan_minutes=0, total_energy=None, total_labour_cost=None),
        ),
        runtime_ms=1,
        input_operation_count=0,
        starts_at=STARTS_AT,
        job_ids=job_ids,
    )
    return stored.schedule.id


def test_a_schedule_lists_exactly_the_jobs_its_generation_selected(
    api: TestClient, worker_db: Session
) -> None:
    with worker_db.begin():
        door, panel, frame = Job(name="Door"), Job(name="Panel"), Job(name="Frame")
        worker_db.add_all([door, panel, frame])
        worker_db.flush()
        schedule_id = _store_draft(worker_db, [panel.id, door.id])
        # Another schedule's selection must not leak into this one.
        _store_draft(worker_db, [frame.id])

    response = api.get(f"/api/v1/schedules/{schedule_id}")

    assert response.status_code == 200, response.text
    assert response.json()["job_ids"] == [str(job_id) for job_id in sorted([door.id, panel.id])]
    assert response.json()["entries"] == []


def test_a_schedule_with_no_selection_was_made_for_the_whole_floor(
    api: TestClient, worker_db: Session
) -> None:
    # What the seed loader writes: a schedule and its entries, no selection rows.
    with worker_db.begin():
        schedule = Schedule(status=SCHEDULE_DRAFT, strategy="seed", starts_at=STARTS_AT)
        worker_db.add(schedule)
        worker_db.flush()
        schedule_id: UUID = schedule.id

    response = api.get(f"/api/v1/schedules/{schedule_id}")

    assert response.status_code == 200, response.text
    assert response.json()["job_ids"] is None
