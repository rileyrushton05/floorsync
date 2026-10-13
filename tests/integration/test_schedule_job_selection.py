"""A schedule reports the jobs its generation was asked for (#303), against a real database.

Generation writes the selection (`SchedulingService.store_draft`, in the worker's synchronous
session) and `GET /api/v1/schedules/{id}` reads it back (`ScheduleReadService`, async). The test
pushes one selection through both, so the two cannot disagree.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from floorsync_common.database.models.job import Job
from floorsync_common.database.models.schedule import SCHEDULE_DRAFT, Schedule
from floorsync_common.scheduling.contracts import ScheduleMetrics, SchedulePlan
from floorsync_common.scheduling.lifecycle import (
    DeleteScheduleResult,
    ScheduleDeleted,
    ScheduleLifecycleService,
    ScheduleNotFound,
)
from floorsync_common.scheduling.reads import GetScheduleResult, ScheduleFound, ScheduleReadService
from floorsync_common.scheduling.service import SchedulingService

STARTS_AT = datetime(2026, 10, 9, 8, tzinfo=UTC)


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


def test_a_draft_deleted_while_it_is_being_read_is_read_whole_or_not_at_all(
    worker_db: Session, database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Run one at a time, the read sees the whole draft or a 404. It must never see the draft row
    # from before the delete and its entries and selection from after it.
    with worker_db.begin():
        job = Job(name="Door")
        worker_db.add(job)
        worker_db.flush()
        schedule_id = _store_draft(worker_db, [job.id])
        job_id = job.id

    async def race() -> tuple[GetScheduleResult, DeleteScheduleResult]:
        engine = create_async_engine(database_url, poolclass=NullPool)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autobegin=False)
        try:
            async with sessions() as reader, sessions() as deleter:

                async def delete() -> DeleteScheduleResult:
                    async with deleter.begin():
                        return await ScheduleLifecycleService.delete_draft(deleter, schedule_id)

                deleting: asyncio.Task[DeleteScheduleResult] | None = None
                read_rest = reader.scalars

                async def scalars_once_a_delete_has_had_its_chance(
                    *args: Any, **kwargs: Any
                ) -> Any:
                    # Forces the timing: the schedule row has been read, the rest has not.
                    nonlocal deleting
                    if deleting is None:
                        deleting = asyncio.create_task(delete())
                        await asyncio.wait({deleting}, timeout=0.5)
                    return await read_rest(*args, **kwargs)

                monkeypatch.setattr(reader, "scalars", scalars_once_a_delete_has_had_its_chance)
                async with reader.begin():
                    read = await ScheduleReadService.get_schedule(reader, schedule_id)
                assert deleting is not None
                return read, await deleting
        finally:
            await engine.dispose()

    read, deleted = asyncio.run(race())

    assert isinstance(read, ScheduleFound), read
    assert read.job_ids == (job_id,)
    assert isinstance(deleted, ScheduleDeleted)


def test_a_draft_read_while_it_is_being_deleted_waits_and_is_not_found(
    worker_db: Session, database_url: str
) -> None:
    # Without the lock the read would not wait and would return the draft as it was before the
    # uncommitted delete: also a valid one-at-a-time order. This pins the lock's behaviour (a read
    # lines up behind a lifecycle change) and the not-found path under real concurrency.
    with worker_db.begin():
        job = Job(name="Door")
        worker_db.add(job)
        worker_db.flush()
        schedule_id = _store_draft(worker_db, [job.id])

    async def race() -> tuple[bool, GetScheduleResult]:
        engine = create_async_engine(database_url, poolclass=NullPool)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autobegin=False)
        try:
            async with sessions() as deleter, sessions() as reader:
                await deleter.begin()
                deleted = await ScheduleLifecycleService.delete_draft(deleter, schedule_id)
                assert isinstance(deleted, ScheduleDeleted)

                async def read() -> GetScheduleResult:
                    async with reader.begin():
                        return await ScheduleReadService.get_schedule(reader, schedule_id)

                reading = asyncio.create_task(read())
                await asyncio.sleep(0.5)
                waited = not reading.done()
                await deleter.commit()
                return waited, await reading
        finally:
            await engine.dispose()

    waited, read = asyncio.run(race())

    assert waited
    assert isinstance(read, ScheduleNotFound)
