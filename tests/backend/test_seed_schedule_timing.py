"""Coverage for #251: a seeded schedule must carry a real start_time on every entry.

Before this fix, `_seed_schedule`/`_seed_flexible_schedule` never wrote `start_time` at all, so a
seeded schedule could never be simulated -- Simulation refuses any entry with a NULL start_time (see
`floorsync_common.simulation.floorsync.FloorSyncScheduleAdapter.build_timeline`). The database round
trip this bug actually depends on (a database that still has the legacy `starts_at`/`ends_at`
columns from before they were dropped) was verified by hand against the real dev Postgres, per
docs/database-conventions.md; see the pull request.
"""

import asyncio
from datetime import datetime, timedelta
from typing import Any, cast

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.seed import loader
from floorsync_common.seed.flexible import parse_flexible_instance
from floorsync_common.seed.instances import parse_instance
from floorsync_common.seed.solutions import parse_solution


class RecordingSession:
    """Stands in for the database: the loader's only writes go through `_insert_all`."""

    def __init__(self) -> None:
        self.rows: dict[str, list[dict[str, Any]]] = {}


def _capture(monkeypatch: pytest.MonkeyPatch, session: RecordingSession) -> None:
    async def clear(_: AsyncSession) -> int:
        return 0

    async def insert_all(_: AsyncSession, model: type[Any], rows: list[dict[str, Any]]) -> None:
        session.rows.setdefault(model.__tablename__, []).extend(rows)

    monkeypatch.setattr(loader, "clear_scheduling_data", clear)
    monkeypatch.setattr(loader, "_insert_all", insert_all)


def _classic_instance_payload() -> dict[str, Any]:
    return {
        "instance": "test01",
        "family": "test",
        "jobs": 2,
        "machines": 2,
        "data": [
            {"job": 0, "operation": 0, "machine": 0, "duration": 5},
            {"job": 0, "operation": 1, "machine": 1, "duration": 7},
            {"job": 1, "operation": 0, "machine": 1, "duration": 3},
        ],
    }


def _classic_solution_payload() -> dict[str, Any]:
    return {
        "instance": "test01",
        "makespan": 15,
        "solver": "test-solver",
        "machine_0": [0],
        "machine_1": [1, 0],
    }


def test_seeded_classic_schedule_gives_every_entry_a_start_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = RecordingSession()
    _capture(monkeypatch, session)

    instance = parse_instance(_classic_instance_payload())
    solution = parse_solution(_classic_solution_payload())

    asyncio.run(loader.seed_instance(cast(AsyncSession, session), instance, solution))

    entries = session.rows["schedule_entries"]
    assert len(entries) == 3
    assert all(isinstance(row["start_time"], datetime) for row in entries)


def _fan_in_flexible_payload() -> dict[str, Any]:
    """Operation 2 waits on both 0 and 1 -- fan-in a classic instance cannot express."""

    return {
        "instance": "test-fan-in",
        "family": "test",
        "operations": [
            {"operation": 0, "option": 0, "machine": 0, "duration": 10},
            {"operation": 1, "option": 0, "machine": 1, "duration": 4},
            {"operation": 2, "option": 0, "machine": 0, "duration": 6},
        ],
        "precedences": [
            {"before": 0, "after": 2, "job": 0},
            {"before": 1, "after": 2, "job": 0},
        ],
    }


def _fan_in_solution_payload() -> dict[str, Any]:
    return {
        "instance": "test-fan-in",
        "makespan": 16,
        "solver": "test-solver",
        "machine_0": [0, 2],
        "machine_1": [1],
    }


def test_seeded_fan_in_schedule_starts_the_merge_after_every_predecessor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Op 2 depends on both 0 (10 min) and 1 (4 min); it must not start before 0 finishes."""

    session = RecordingSession()
    _capture(monkeypatch, session)

    instance = parse_flexible_instance(_fan_in_flexible_payload())
    solution = parse_solution(_fan_in_solution_payload())

    asyncio.run(loader.seed_flexible_instance(cast(AsyncSession, session), instance, solution))

    entries = session.rows["schedule_entries"]
    assert all(isinstance(row["start_time"], datetime) for row in entries)

    names = {row["id"]: row["name"] for row in session.rows["operations"]}
    by_name = {names[row["operation_id"]]: row for row in entries}
    ends = {
        name: row["start_time"] + timedelta(minutes=row["duration"])
        for name, row in by_name.items()
    }

    assert by_name["Op2"]["start_time"] >= ends["Op0"]
    assert by_name["Op2"]["start_time"] >= ends["Op1"]
    assert by_name["Op2"]["start_time"] == max(ends["Op0"], ends["Op1"])
