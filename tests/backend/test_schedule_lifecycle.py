"""Confirming and discarding a schedule (#268, decision 0015).

The service half runs the real transitions against a fake session that answers each named read;
the route half checks the one `PATCH` maps every outcome to the documented status.
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
from floorsync_common.database.models.schedule import Schedule
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.database.models.user import User
from floorsync_common.scheduling import lifecycle
from floorsync_common.scheduling.lifecycle import (
    ScheduleConfirmed,
    ScheduleDiscarded,
    ScheduleIsDraft,
    ScheduleLifecycleService,
    ScheduleNotFound,
    ScheduleRenamed,
    ScheduleSimulationStarted,
)
from floorsync_common.settings import Settings

CREATED_AT = datetime(2026, 9, 18, 8, tzinfo=UTC)
CONFIRMED_AT = datetime(2026, 9, 18, 9, tzinfo=UTC)
MANAGER_ID = uuid4()


def _schedule(status: str = "draft", confirmed: bool = False) -> Schedule:
    return Schedule(
        id=uuid4(),
        status=status,
        strategy="resched",
        starts_at=CREATED_AT,
        created_at=CREATED_AT,
        updated_at=CREATED_AT,
        confirmed_by_user_id=MANAGER_ID if confirmed else None,
        confirmed_at=CONFIRMED_AT if confirmed else None,
    )


def _simulation(schedule: Schedule, status: str = "not_started") -> Simulation:
    return Simulation(id=uuid4(), schedule_id=schedule.id, status=status)


class FakeSession:
    """Answer the three named reads the transitions make; record deletes and flushes."""

    def __init__(
        self,
        schedule: Schedule | None,
        *,
        simulation: Simulation | None = None,
        simulation_has_events: bool = False,
    ) -> None:
        self.schedule = schedule
        self.simulation = simulation
        self.simulation_has_events = simulation_has_events
        self.locked = False
        self.deleted: list[Any] = []
        self.flushes = 0

    async def scalar(self, statement: Any) -> Any:
        rendered = str(statement)
        if "FROM schedules" in rendered:
            self.locked = "FOR UPDATE" in rendered
            return self.schedule
        if "FROM simulation_events" in rendered:
            return uuid4() if self.simulation_has_events else None
        if "FROM simulations" in rendered:
            return self.simulation
        raise AssertionError(f"Unexpected read: {rendered}")

    async def delete(self, item: Any) -> None:
        self.deleted.append(item)

    async def flush(self) -> None:
        self.flushes += 1


def _run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def _confirm(fake: FakeSession, schedule_id: UUID) -> Any:
    return _run(
        ScheduleLifecycleService.confirm(
            cast(AsyncSession, fake), schedule_id, confirmed_by=MANAGER_ID, at=CONFIRMED_AT
        )
    )


def _discard(fake: FakeSession, schedule_id: UUID) -> Any:
    return _run(ScheduleLifecycleService.discard(cast(AsyncSession, fake), schedule_id))


# -- confirm ----------------------------------------------------------------------------------


def test_confirming_a_draft_records_who_and_when() -> None:
    schedule = _schedule("draft")
    fake = FakeSession(schedule)

    result = _confirm(fake, schedule.id)

    assert result == ScheduleConfirmed(schedule=schedule)
    assert schedule.status == "confirmed"
    assert schedule.confirmed_by_user_id == MANAGER_ID
    assert schedule.confirmed_at == CONFIRMED_AT
    assert fake.locked and fake.flushes == 1


def test_confirming_a_discarded_schedule_restores_it() -> None:
    schedule = _schedule("discarded", confirmed=True)
    other_manager = uuid4()

    result = _run(
        ScheduleLifecycleService.confirm(
            cast(AsyncSession, FakeSession(schedule)), schedule.id, confirmed_by=other_manager
        )
    )

    assert isinstance(result, ScheduleConfirmed)
    assert schedule.status == "confirmed"
    assert schedule.confirmed_by_user_id == other_manager
    assert schedule.confirmed_at is not None and schedule.confirmed_at > CONFIRMED_AT


def test_confirming_twice_keeps_the_original_audit_trail() -> None:
    schedule = _schedule("confirmed", confirmed=True)
    fake = FakeSession(schedule)

    result = _run(
        ScheduleLifecycleService.confirm(
            cast(AsyncSession, fake), schedule.id, confirmed_by=uuid4()
        )
    )

    assert result == ScheduleConfirmed(schedule=schedule)
    assert schedule.confirmed_by_user_id == MANAGER_ID
    assert schedule.confirmed_at == CONFIRMED_AT
    assert fake.flushes == 0


def test_confirming_a_missing_schedule_is_reported() -> None:
    schedule_id = uuid4()

    assert _confirm(FakeSession(None), schedule_id) == ScheduleNotFound(schedule_id=schedule_id)


# -- discard ----------------------------------------------------------------------------------


def test_discarding_a_confirmed_schedule_keeps_its_confirmation_details() -> None:
    schedule = _schedule("confirmed", confirmed=True)
    fake = FakeSession(schedule)

    result = _discard(fake, schedule.id)

    assert result == ScheduleDiscarded(schedule=schedule)
    assert schedule.status == "discarded"
    assert schedule.confirmed_by_user_id == MANAGER_ID
    assert schedule.confirmed_at == CONFIRMED_AT
    assert fake.locked and fake.deleted == [] and fake.flushes == 1


def test_discarding_removes_a_simulation_that_was_never_started() -> None:
    schedule = _schedule("confirmed", confirmed=True)
    simulation = _simulation(schedule)
    fake = FakeSession(schedule, simulation=simulation, simulation_has_events=False)

    result = _discard(fake, schedule.id)

    assert isinstance(result, ScheduleDiscarded)
    assert fake.deleted == [simulation]


def test_discarding_is_refused_once_the_simulation_has_any_event() -> None:
    """A reset simulation is `not_started` again but its log says the floor ran it."""

    schedule = _schedule("confirmed", confirmed=True)
    simulation = _simulation(schedule, status="not_started")
    fake = FakeSession(schedule, simulation=simulation, simulation_has_events=True)

    result = _discard(fake, schedule.id)

    assert result == ScheduleSimulationStarted(
        schedule_id=schedule.id, simulation_id=simulation.id, simulation_status="not_started"
    )
    assert schedule.status == "confirmed"
    assert fake.deleted == [] and fake.flushes == 0


def test_discarding_a_draft_is_refused() -> None:
    schedule = _schedule("draft")

    result = _discard(FakeSession(schedule), schedule.id)

    assert result == ScheduleIsDraft(schedule_id=schedule.id)
    assert schedule.status == "draft"


def test_discarding_twice_is_a_no_op() -> None:
    schedule = _schedule("discarded", confirmed=True)
    fake = FakeSession(schedule)

    result = _discard(fake, schedule.id)

    assert result == ScheduleDiscarded(schedule=schedule)
    assert fake.flushes == 0


def test_discarding_a_missing_schedule_is_reported() -> None:
    schedule_id = uuid4()

    assert _discard(FakeSession(None), schedule_id) == ScheduleNotFound(schedule_id=schedule_id)


# -- route ------------------------------------------------------------------------------------


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_: object) -> None:
        return None


class RouteSession:
    def begin(self) -> FakeTransaction:
        return FakeTransaction()


def _client(role: str = "manager", user_id: UUID = MANAGER_ID) -> TestClient:
    from floorsync_api.main import create_application

    application = create_application(Settings(environment="test"))
    user = User(
        id=user_id, name="Ada", role=role, machine_id=None if role == "manager" else uuid4()
    )

    async def get_test_db_session() -> AsyncIterator[AsyncSession]:
        yield cast(AsyncSession, RouteSession())

    async def get_test_current_user() -> User:
        return user

    application.dependency_overrides[get_db_session] = get_test_db_session
    application.dependency_overrides[get_current_user] = get_test_current_user
    return TestClient(application)


def _patch(client: TestClient, schedule_id: UUID, new_status: str) -> Any:
    return client.patch(f"/api/v1/schedules/{schedule_id}", json={"status": new_status})


def test_confirm_route_passes_the_manager_and_returns_the_summary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schedule = _schedule("confirmed", confirmed=True)
    received: dict[str, Any] = {}

    async def fake(_: object, schedule_id: UUID, **kwargs: Any) -> ScheduleConfirmed:
        received.update(kwargs, schedule_id=schedule_id)
        return ScheduleConfirmed(schedule=schedule)

    monkeypatch.setattr(lifecycle.ScheduleLifecycleService, "confirm", staticmethod(fake))

    response = _patch(_client(), schedule.id, "confirmed")

    assert response.status_code == 200
    assert received == {"schedule_id": schedule.id, "confirmed_by": MANAGER_ID}
    body = response.json()
    assert body["status"] == "confirmed"
    assert body["confirmed_by_user_id"] == str(MANAGER_ID)
    assert datetime.fromisoformat(body["confirmed_at"]) == CONFIRMED_AT
    assert "entries" not in body


def _stub_discard(monkeypatch: pytest.MonkeyPatch, outcome: object) -> None:
    async def fake(*_: object, **__: object) -> object:
        return outcome

    monkeypatch.setattr(lifecycle.ScheduleLifecycleService, "discard", staticmethod(fake))


def test_discard_route_returns_the_summary(monkeypatch: pytest.MonkeyPatch) -> None:
    schedule = _schedule("discarded", confirmed=True)
    _stub_discard(monkeypatch, ScheduleDiscarded(schedule=schedule))

    response = _patch(_client(), schedule.id, "discarded")

    assert response.status_code == 200
    assert response.json()["status"] == "discarded"


def test_discarding_a_draft_answers_409_pointing_at_delete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schedule_id = uuid4()
    _stub_discard(monkeypatch, ScheduleIsDraft(schedule_id=schedule_id))

    response = _patch(_client(), schedule_id, "discarded")

    assert response.status_code == 409
    body = response.json()
    assert body["type"] == "urn:floorsync:problem:schedule-is-draft"
    assert "DELETE /api/v1/schedules" in body["detail"]


def test_a_started_simulation_answers_409_naming_it(monkeypatch: pytest.MonkeyPatch) -> None:
    schedule_id, simulation_id = uuid4(), uuid4()
    _stub_discard(
        monkeypatch,
        ScheduleSimulationStarted(
            schedule_id=schedule_id, simulation_id=simulation_id, simulation_status="paused"
        ),
    )

    response = _patch(_client(), schedule_id, "discarded")

    assert response.status_code == 409
    body = response.json()
    assert body["type"] == "urn:floorsync:problem:schedule-simulation-started"
    assert body["simulation_id"] == str(simulation_id)
    assert body["simulation_status"] == "paused"


def test_a_missing_schedule_answers_404(monkeypatch: pytest.MonkeyPatch) -> None:
    schedule_id = uuid4()
    _stub_discard(monkeypatch, ScheduleNotFound(schedule_id=schedule_id))

    assert _patch(_client(), schedule_id, "discarded").status_code == 404


def test_there_is_no_way_back_to_draft() -> None:
    response = _patch(_client(), uuid4(), "draft")

    assert response.status_code == 422
    assert "status" in response.text


def test_an_operator_cannot_change_a_schedules_status() -> None:
    assert _patch(_client(role="operator"), uuid4(), "confirmed").status_code == 403


# -- rename -----------------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["draft", "confirmed", "discarded"])
def test_a_schedule_can_be_renamed_in_any_status(status: str) -> None:
    schedule = _schedule(status, confirmed=status != "draft")
    fake = FakeSession(schedule)

    result = _run(ScheduleLifecycleService.rename(cast(AsyncSession, fake), schedule.id, "Week 41"))

    assert result == ScheduleRenamed(schedule=schedule)
    assert schedule.name == "Week 41"
    assert schedule.status == status
    assert fake.locked and fake.flushes == 1


def test_renaming_a_missing_schedule_reports_not_found() -> None:
    schedule_id = uuid4()

    result = _run(
        ScheduleLifecycleService.rename(cast(AsyncSession, FakeSession(None)), schedule_id, "X")
    )

    assert result == ScheduleNotFound(schedule_id=schedule_id)


def _stub_rename(monkeypatch: pytest.MonkeyPatch, calls: list[str]) -> None:
    async def fake(_: object, schedule_id: UUID, name: str) -> object:
        calls.append(name)
        schedule = _schedule("draft")
        schedule.id = schedule_id
        schedule.name = name
        return ScheduleRenamed(schedule=schedule)

    monkeypatch.setattr(lifecycle.ScheduleLifecycleService, "rename", staticmethod(fake))


def test_rename_route_trims_and_returns_the_name(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    _stub_rename(monkeypatch, calls)

    response = _client().patch(f"/api/v1/schedules/{uuid4()}", json={"name": "  Week 41  "})

    assert response.status_code == 200
    assert calls == ["Week 41"]
    assert response.json()["name"] == "Week 41"
    assert response.json()["status"] == "draft"


def test_saving_confirms_then_renames(monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []
    schedule = _schedule("confirmed", confirmed=True)

    async def fake_confirm(_: object, __: UUID, **___: Any) -> ScheduleConfirmed:
        order.append("confirm")
        return ScheduleConfirmed(schedule=schedule)

    async def fake_rename(_: object, __: UUID, name: str) -> ScheduleRenamed:
        order.append("rename")
        schedule.name = name
        return ScheduleRenamed(schedule=schedule)

    monkeypatch.setattr(lifecycle.ScheduleLifecycleService, "confirm", staticmethod(fake_confirm))
    monkeypatch.setattr(lifecycle.ScheduleLifecycleService, "rename", staticmethod(fake_rename))

    response = _client().patch(
        f"/api/v1/schedules/{schedule.id}", json={"status": "confirmed", "name": "Week 41"}
    )

    assert response.status_code == 200
    assert order == ["confirm", "rename"]
    assert response.json()["name"] == "Week 41"
    assert response.json()["status"] == "confirmed"


def test_a_refused_transition_renames_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    _stub_rename(monkeypatch, calls)
    _stub_discard(monkeypatch, ScheduleIsDraft(schedule_id=uuid4()))

    response = _client().patch(
        f"/api/v1/schedules/{uuid4()}", json={"status": "discarded", "name": "Week 41"}
    )

    assert response.status_code == 409
    assert calls == []


@pytest.mark.parametrize(
    "body",
    [{}, {"name": ""}, {"name": "   "}, {"name": None}, {"status": None}, {"name": "x" * 121}],
)
def test_an_update_must_carry_a_real_change(body: dict[str, Any]) -> None:
    assert _client().patch(f"/api/v1/schedules/{uuid4()}", json=body).status_code == 422
