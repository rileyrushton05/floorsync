from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from floorsync_common.scheduling import SchedulingInputInvalid, SchedulingIssue
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
