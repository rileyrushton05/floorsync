from collections.abc import Collection, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from floorsync_common.scheduling import (
    ScheduleStored,
    SchedulingInput,
    SchedulingInputInvalid,
    SchedulingIssue,
)
from floorsync_common.scheduling.gurobi_exact_solver import STRATEGY as EXACT_SOLVER_STRATEGY
from floorsync_workers.tasks import schedules


@contextmanager
def _fake_session_scope() -> Iterator[object]:
    yield object()


def _loaded_input() -> SchedulingInput:
    """The smallest thing `load_input` can hand back that the worker will pass on to the engine.

    A bare `object()` no longer works there: the worker matches the loaded result exhaustively and
    ends with `assert_never`, so an unknown stand-in is a failure rather than something passed
    through unexamined.
    """

    return SchedulingInput(
        starts_at=datetime(2026, 9, 6, 8, tzinfo=UTC),
        machines=(),
        operations=(),
        routes=(),
        dependencies=(),
    )


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
    ) -> SchedulingInput:
        assert starts_at == datetime(2026, 9, 6, 8, tzinfo=UTC)
        return _loaded_input()

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


def test_exact_worker_closes_the_read_transaction_before_solving(monkeypatch: Any) -> None:
    transaction_open = False
    stored_schedule_id = uuid4()

    @contextmanager
    def fake_session_scope() -> object:
        nonlocal transaction_open
        transaction_open = True
        try:
            yield object()
        finally:
            transaction_open = False

    def load_fajsp_from_db(_: object) -> tuple[object, ...]:
        assert transaction_open
        return ("jobs", "machines", "operations", "eligible", "operation_data", "machine_meta")

    def solve_fajsp(
        operations: object,
        eligible_machines: object,
        operation_data: object,
        machine_meta: object,
        starts_at: datetime,
    ) -> tuple[object, int]:
        assert not transaction_open
        assert operations == "operations"
        assert eligible_machines == "eligible"
        assert operation_data == "operation_data"
        assert machine_meta == "machine_meta"
        assert starts_at == datetime(2026, 9, 6, 8, tzinfo=UTC)
        return "plan", 1234

    def store_draft(
        _: object,
        *,
        plan: object,
        runtime_ms: int,
        input_operation_count: int,
        strategy: str | None = None,
    ) -> ScheduleStored:
        assert transaction_open
        assert plan == "plan"
        assert runtime_ms == 1234
        assert input_operation_count == len("operation_data")
        assert strategy == EXACT_SOLVER_STRATEGY

        class _Schedule:
            id = stored_schedule_id

        return ScheduleStored(schedule=_Schedule())  # type: ignore[arg-type]

    monkeypatch.setattr(schedules, "worker_session_scope", fake_session_scope)
    monkeypatch.setattr(schedules, "load_fajsp_from_db", load_fajsp_from_db)
    monkeypatch.setattr(schedules, "solve_fajsp", solve_fajsp)
    monkeypatch.setattr(schedules.SchedulingService, "store_draft", staticmethod(store_draft))

    result = schedules.generate_schedule_exact.run("2026-09-06T08:00:00+00:00")

    assert result == {"outcome": "stored", "schedule_id": str(stored_schedule_id)}


def test_a_task_queued_without_a_selection_still_plans_the_whole_floor(monkeypatch: Any) -> None:
    """`job_ids` defaults to None, so a message queued before #231 survives the deploy."""

    seen: list[Collection[UUID] | None] = []

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> SchedulingInput:
        seen.append(job_ids)
        return _loaded_input()

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
    ) -> SchedulingInput:
        seen.append(job_ids)
        return _loaded_input()

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
