from collections.abc import Collection, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from floorsync_common.scheduling import SchedulingInputInvalid, SchedulingIssue
from floorsync_workers.tasks import schedules


@contextmanager
def _fake_session_scope() -> Iterator[object]:
    yield object()


def test_worker_closes_the_read_transaction_before_running_resched(monkeypatch: Any) -> None:
    transaction_open = False

    @contextmanager
    def fake_session_scope() -> object:
        nonlocal transaction_open
        transaction_open = True
        try:
            yield object()
        finally:
            transaction_open = False

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> object:
        assert starts_at == datetime(2026, 9, 6, 8, tzinfo=UTC)
        return object()

    def generate(_: object) -> SchedulingInputInvalid:
        assert not transaction_open
        return SchedulingInputInvalid(issues=(SchedulingIssue("no_operations", "No work."),))

    monkeypatch.setattr(schedules, "worker_session_scope", fake_session_scope)
    monkeypatch.setattr(schedules.SchedulingService, "load_input", staticmethod(load_input))
    monkeypatch.setattr(schedules.ReSchedEngine, "generate", staticmethod(generate))

    result = schedules.generate_schedule.run("2026-09-06T08:00:00+00:00")

    assert result == {
        "outcome": "invalid",
        "issues": [{"code": "no_operations", "message": "No work."}],
    }


def test_a_task_queued_without_a_selection_still_plans_the_whole_floor(monkeypatch: Any) -> None:
    """`job_ids` defaults to None, so a message queued before #231 survives the deploy."""

    seen: list[Collection[UUID] | None] = []

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> object:
        seen.append(job_ids)
        return object()

    monkeypatch.setattr(schedules, "worker_session_scope", _fake_session_scope)
    monkeypatch.setattr(schedules.SchedulingService, "load_input", staticmethod(load_input))
    monkeypatch.setattr(
        schedules.ReSchedEngine,
        "generate",
        staticmethod(lambda _: SchedulingInputInvalid(issues=(SchedulingIssue("x", "y"),))),
    )

    schedules.generate_schedule.run("2026-09-06T08:00:00+00:00")

    assert seen == [None]


def test_the_worker_parses_the_selection_back_into_job_ids(monkeypatch: Any) -> None:
    """The selection crosses the queue as strings and has to arrive at the service as UUIDs."""

    first, second = uuid4(), uuid4()
    seen: list[Collection[UUID] | None] = []

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> object:
        seen.append(job_ids)
        return object()

    monkeypatch.setattr(schedules, "worker_session_scope", _fake_session_scope)
    monkeypatch.setattr(schedules.SchedulingService, "load_input", staticmethod(load_input))
    monkeypatch.setattr(
        schedules.ReSchedEngine,
        "generate",
        staticmethod(lambda _: SchedulingInputInvalid(issues=(SchedulingIssue("x", "y"),))),
    )

    schedules.generate_schedule.run("2026-09-06T08:00:00+00:00", [str(first), str(second)])

    assert seen == [[first, second]]


def test_a_refused_selection_never_reaches_the_engine(monkeypatch: Any) -> None:
    """There is nothing to run inference on, and the refusal already says what is wrong."""

    job_id = uuid4()
    generated = False

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> SchedulingInputInvalid:
        return SchedulingInputInvalid(
            issues=(SchedulingIssue("unknown_job", "No such job.", job_id=job_id),)
        )

    def generate(_: object) -> object:
        nonlocal generated
        generated = True
        raise AssertionError("the engine must not run on a refused selection")

    monkeypatch.setattr(schedules, "worker_session_scope", _fake_session_scope)
    monkeypatch.setattr(schedules.SchedulingService, "load_input", staticmethod(load_input))
    monkeypatch.setattr(schedules.ReSchedEngine, "generate", staticmethod(generate))

    result = schedules.generate_schedule.run("2026-09-06T08:00:00+00:00", [str(job_id)])

    assert not generated
    assert result == {
        "outcome": "invalid",
        "issues": [
            {"code": "unknown_job", "message": "No such job.", "job_id": str(job_id)},
        ],
    }
