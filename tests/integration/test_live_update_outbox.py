"""The outbox guarantees decision 0017 rests on, proven against a real PostgreSQL (#148).

Each of these is a property of the database, not of Python: a control and its notification
committing or rolling back together, the simulation row lock making a second control wait and
then see the first one's result, and `SKIP LOCKED` giving two relays disjoint rows. The unit tests
in `tests/backend` fake the session and cannot observe any of it.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import assert_never
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from floorsync_common.database.models.job import Job
from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.schedule import SCHEDULE_CONFIRMED, Schedule
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.database.models.simulation_event import SimulationEvent
from floorsync_common.live_updates.results import (
    OutboxRowAlreadySettled,
    OutboxRowPublished,
)
from floorsync_common.live_updates.service import LiveUpdateOutboxService
from floorsync_common.simulation.events import SimulationEventType
from floorsync_common.simulation.results import (
    ControlNotApplicable,
    ControlRecorded,
    ControlSpeedRequired,
    RecordControlResult,
    ScheduleNotGenerated,
    SimulationCreated,
    SimulationNotFound,
)
from floorsync_common.simulation.service import SimulationService

T0 = datetime(2026, 9, 25, 8, tzinfo=UTC)

type Sessions = async_sessionmaker[AsyncSession]


def run[T](database_url: str, test: Callable[[Sessions], Awaitable[T]]) -> T:
    """Run one test body with a session factory bound to the test database."""

    async def body() -> T:
        engine = create_async_engine(database_url, poolclass=NullPool)
        try:
            return await test(async_sessionmaker(engine, expire_on_commit=False, autobegin=False))
        finally:
            await engine.dispose()

    return asyncio.run(body())


@asynccontextmanager
async def transaction(sessions: Sessions) -> AsyncIterator[AsyncSession]:
    async with sessions() as db, db.begin():
        yield db


async def a_confirmed_schedule_with_a_simulation(sessions: Sessions) -> UUID:
    """The smallest floor a simulation can be controlled on: one entry, one hour long."""
    async with transaction(sessions) as db:
        machine = Machine(name=f"M-{uuid4().hex[:6]}")
        job = Job(name="J1")
        db.add_all([machine, job])
        await db.flush()
        operation = Operation(job_id=job.id, name="cut", position=1)
        schedule = Schedule(status=SCHEDULE_CONFIRMED, strategy="test", confirmed_at=T0)
        db.add_all([operation, schedule])
        await db.flush()
        db.add(
            ScheduleEntry(
                schedule_id=schedule.id,
                operation_id=operation.id,
                machine_id=machine.id,
                duration=60,
                start_time=T0,
            )
        )
        created = await SimulationService.create_simulation(db, schedule_id=schedule.id)
        assert isinstance(created, SimulationCreated)
        return created.simulation.id


async def record_and_enqueue(
    db: AsyncSession,
    simulation_id: UUID,
    event_type: SimulationEventType,
    *,
    at: datetime,
    speed: Decimal | None = None,
) -> RecordControlResult:
    """What the control route does inside its one transaction."""
    result = await SimulationService.record_control(
        db, simulation_id=simulation_id, event_type=event_type, speed=speed, at=at
    )
    match result:
        case ControlRecorded(simulation=simulation, position=position, makespan=makespan):
            await LiveUpdateOutboxService.enqueue_simulation_change(
                db,
                simulation=simulation,
                position=position,
                makespan=makespan,
                cause="started" if event_type is SimulationEventType.STARTED else "paused",
                occurred_at=at,
            )
        case (
            ControlNotApplicable()
            | ControlSpeedRequired()
            | SimulationNotFound()
            | ScheduleNotGenerated()
        ):
            pass
        case _:
            assert_never(result)
    return result


async def counts(sessions: Sessions, simulation_id: UUID) -> tuple[int, int, int]:
    """(events recorded, outbox rows written, live sequence) for one simulation."""
    async with transaction(sessions) as db:
        events = await db.scalar(
            select(func.count())
            .select_from(SimulationEvent)
            .where(SimulationEvent.simulation_id == simulation_id)
        )
        rows = await db.scalar(
            select(func.count())
            .select_from(LiveUpdateOutbox)
            .where(LiveUpdateOutbox.aggregate_id == simulation_id)
        )
        sequence = await db.scalar(
            select(Simulation.live_sequence).where(Simulation.id == simulation_id)
        )
    return events or 0, rows or 0, sequence or 0


async def outbox_rows(sessions: Sessions, *due_at: datetime) -> list[UUID]:
    """Write one unpublished row per `due_at`, each for its own aggregate, in the given order."""
    ids = [uuid4() for _ in due_at]
    async with transaction(sessions) as db:
        for outbox_id, due in zip(ids, due_at, strict=True):
            db.add(
                LiveUpdateOutbox(
                    id=outbox_id,
                    topic="simulation.changed",
                    aggregate_id=uuid4(),
                    sequence=1,
                    payload={},
                    next_attempt_at=due,
                )
            )
    return ids


# -- a control and its notification are one transaction --------------------


def test_a_recorded_control_commits_exactly_one_ordered_outbox_row(database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        simulation_id = await a_confirmed_schedule_with_a_simulation(sessions)

        async with transaction(sessions) as db:
            await record_and_enqueue(
                db, simulation_id, SimulationEventType.STARTED, at=T0, speed=Decimal("1")
            )

        assert await counts(sessions, simulation_id) == (1, 1, 1)
        async with transaction(sessions) as db:
            row = await db.scalar(
                select(LiveUpdateOutbox).where(LiveUpdateOutbox.aggregate_id == simulation_id)
            )
        assert row is not None
        assert row.sequence == 1
        assert row.published_at is None
        assert row.payload["sequence"] == 1
        assert row.payload["event_id"] == str(row.id)

    run(database_url, body)


def test_a_rolled_back_control_leaves_no_event_row_or_sequence(database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        simulation_id = await a_confirmed_schedule_with_a_simulation(sessions)

        class Abandon(Exception):
            pass

        try:
            async with transaction(sessions) as db:
                await record_and_enqueue(
                    db, simulation_id, SimulationEventType.STARTED, at=T0, speed=Decimal("1")
                )
                raise Abandon
        except Abandon:
            pass

        assert await counts(sessions, simulation_id) == (0, 0, 0)

    run(database_url, body)


# -- the simulation row lock serialises concurrent controls ------------------


def test_a_second_control_waits_for_the_first_and_judges_its_result(database_url: str) -> None:
    """Two managers press pause at once. Without the lock both would see `running` and both would
    record a pause; with it, the second waits, then sees `paused` and is refused."""

    async def body(sessions: Sessions) -> None:
        simulation_id = await a_confirmed_schedule_with_a_simulation(sessions)
        async with transaction(sessions) as db:
            await record_and_enqueue(
                db, simulation_id, SimulationEventType.STARTED, at=T0, speed=Decimal("1")
            )

        first_holds_lock = asyncio.Event()
        release_first = asyncio.Event()

        async def first() -> RecordControlResult:
            async with transaction(sessions) as db:
                result = await record_and_enqueue(
                    db, simulation_id, SimulationEventType.PAUSED, at=T0 + timedelta(minutes=1)
                )
                first_holds_lock.set()
                await release_first.wait()
                return result

        async def second() -> RecordControlResult:
            await first_holds_lock.wait()
            async with transaction(sessions) as db:
                return await record_and_enqueue(
                    db, simulation_id, SimulationEventType.PAUSED, at=T0 + timedelta(minutes=1)
                )

        first_task = asyncio.create_task(first())
        second_task = asyncio.create_task(second())
        await first_holds_lock.wait()
        await asyncio.sleep(0.5)
        assert not second_task.done(), "the second control did not wait for the row lock"

        release_first.set()
        first_result, second_result = await asyncio.gather(first_task, second_task)

        assert isinstance(first_result, ControlRecorded)
        assert isinstance(second_result, ControlNotApplicable)
        assert second_result.status == "paused"
        assert await counts(sessions, simulation_id) == (2, 2, 2)

    run(database_url, body)


# -- relays claim disjoint rows ----------------------------------------------


def test_two_relays_never_claim_the_same_row_and_neither_waits(database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        ids = await outbox_rows(sessions, *(T0 + timedelta(seconds=n) for n in range(4)))
        now = T0 + timedelta(minutes=1)

        async with transaction(sessions) as first:
            claimed_first = await LiveUpdateOutboxService.claim_due(first, now=now, limit=2)
            async with transaction(sessions) as second:
                # Would block forever without SKIP LOCKED, since `first` still holds its rows.
                claimed_second = await asyncio.wait_for(
                    LiveUpdateOutboxService.claim_due(second, now=now, limit=10), timeout=5
                )

        first_ids = [row.id for row in claimed_first]
        second_ids = [row.id for row in claimed_second]
        assert first_ids == ids[:2]
        assert second_ids == ids[2:]

    run(database_url, body)


def test_claim_due_skips_published_and_not_yet_due_rows(database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        later, published, due = await outbox_rows(
            sessions, T0 + timedelta(hours=1), T0, T0 + timedelta(seconds=1)
        )
        async with transaction(sessions) as db:
            await LiveUpdateOutboxService.mark_published(db, published, at=T0)

        async with transaction(sessions) as db:
            claimed = await LiveUpdateOutboxService.claim_due(
                db, now=T0 + timedelta(minutes=1), limit=10
            )
        assert [row.id for row in claimed] == [due]
        assert later not in [row.id for row in claimed]

    run(database_url, body)


# -- settling a row ------------------------------------------------------------


def test_only_the_first_caller_marks_a_row_published(database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        (outbox_id,) = await outbox_rows(sessions, T0)
        async with transaction(sessions) as db:
            first = await LiveUpdateOutboxService.mark_published(db, outbox_id, at=T0)
        async with transaction(sessions) as db:
            second = await LiveUpdateOutboxService.mark_published(
                db, outbox_id, at=T0 + timedelta(seconds=5)
            )
            reloaded = await LiveUpdateOutboxService.load_unpublished(db, outbox_id)
            published_at = await db.scalar(
                select(LiveUpdateOutbox.published_at).where(LiveUpdateOutbox.id == outbox_id)
            )

        assert first == OutboxRowPublished(outbox_id=outbox_id)
        assert second == OutboxRowAlreadySettled(outbox_id=outbox_id)
        assert reloaded is None
        assert published_at == T0

    run(database_url, body)


def test_a_failed_publish_is_counted_and_held_back_until_its_retry_time(
    database_url: str,
) -> None:
    async def body(sessions: Sessions) -> None:
        (outbox_id,) = await outbox_rows(sessions, T0)
        retry_at = T0 + timedelta(seconds=30)
        async with transaction(sessions) as db:
            await LiveUpdateOutboxService.record_failure(
                db, outbox_id, error_code="ConnectionError", retry_at=retry_at
            )

        async with transaction(sessions) as db:
            before = await LiveUpdateOutboxService.claim_due(
                db, now=retry_at - timedelta(seconds=1), limit=10
            )
        async with transaction(sessions) as db:
            after = await LiveUpdateOutboxService.claim_due(db, now=retry_at, limit=10)
            assert (after[0].attempt_count, after[0].last_error_code) == (1, "ConnectionError")

        assert before == []
        assert [claimed.id for claimed in after] == [outbox_id]

    run(database_url, body)


def test_the_backlog_counts_only_unpublished_rows(database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        async with transaction(sessions) as db:
            empty = await LiveUpdateOutboxService.backlog(db)
        published, _, _ = await outbox_rows(sessions, T0, T0, T0)
        async with transaction(sessions) as db:
            await LiveUpdateOutboxService.mark_published(db, published, at=T0)
        async with transaction(sessions) as db:
            backlog = await LiveUpdateOutboxService.backlog(db)

        assert (empty.unpublished_count, empty.oldest_created_at) == (0, None)
        assert backlog.unpublished_count == 2
        assert backlog.oldest_created_at is not None

    run(database_url, body)
