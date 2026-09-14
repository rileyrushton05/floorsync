from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from floorsync_common.scheduling import (
    ScheduleStored,
    SchedulingInputInvalid,
    SchedulingIssue,
)
from floorsync_common.scheduling.gurobi_exact_solver import STRATEGY as EXACT_SOLVER_STRATEGY
from floorsync_workers.tasks import schedules


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

    def load_input(_: object, *, starts_at: datetime) -> object:
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
