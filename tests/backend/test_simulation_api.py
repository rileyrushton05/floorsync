"""Tests for the simulation service, queries and HTTP routes.

The database is faked rather than mocked at the SQLAlchemy level: a
`FakeSession` returns canned rows for each named query, which is enough to
exercise the service's outcomes and the route's mapping of them. Behaviour that
genuinely depends on PostgreSQL (constraints, the one-simulation-per-schedule
unique index) belongs in integration tests once the migration exists.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from floorsync_api.dependencies.authentication import get_current_user, require_roles
from floorsync_api.dependencies.database import get_db_session
from floorsync_api.features.simulation.router import router as simulation_router
from floorsync_api.features.simulation.schemas import TimelineResponse
from floorsync_api.problems import install_problem_handlers
from floorsync_common.simulation import (
    FloorSyncScheduleAdapter,
    SimulationEventType,
)
from floorsync_common.simulation.results import (
    ControlNotApplicable,
    ControlRecorded,
    ControlSpeedRequired,
    ScheduleNotConfirmed,
    ScheduleNotFound,
    ScheduleNotGenerated,
    SimulationAlreadyExists,
    SimulationCreated,
    SimulationNotFound,
    SimulationPositionResolved,
    TimelineResolved,
)
from floorsync_common.simulation.service import (
    ScheduleTimelineService,
    SimulationService,
    control_is_applicable,
    control_requires_speed,
)

NOW = datetime(2026, 9, 6, 9, 0, tzinfo=UTC)

SCHEDULE_ID = UUID("11111111-1111-4111-8111-111111111111")
SIMULATION_ID = UUID("22222222-2222-4222-8222-222222222222")
CUT = UUID("33333333-3333-4333-8333-333333333333")
POLISH = UUID("44444444-4444-4444-8444-444444444444")
FRAME = UUID("55555555-5555-4555-8555-555555555555")
CUTTER = UUID("66666666-6666-4666-8666-666666666666")
POLISHER = UUID("77777777-7777-4777-8777-777777777777")

# Frame: Cut on the Cutter for 3, then Polish on the Polisher for 2. Makespan 5.
ENTRY_ROWS: list[tuple[UUID, UUID, UUID, int, str, str, str]] = [
    (CUT, FRAME, CUTTER, 3, "Frame", "Cutter", "Cut"),
    (POLISH, FRAME, POLISHER, 2, "Frame", "Polisher", "Polish"),
]
DEPENDENCY_ROWS: list[tuple[UUID, UUID, str]] = [(POLISH, CUT, "job_order")]


class FakeSchedule:
    def __init__(self, status: str = "confirmed") -> None:
        self.id = SCHEDULE_ID
        self.status = status


class FakeSimulation:
    def __init__(self, status: str = "not_started") -> None:
        self.id = SIMULATION_ID
        self.schedule_id = SCHEDULE_ID
        self.status = status
        self.speed = Decimal("1")
        self.started_at: datetime | None = None
        self.completed_at: datetime | None = None


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_: object) -> None:
        return None


class FakeSession:
    """Answer each named query with canned rows, recording what was added."""

    def __init__(
        self,
        *,
        schedule: FakeSchedule | None = None,
        simulation: FakeSimulation | None = None,
        entry_rows: list[tuple[UUID, UUID, UUID, int, str, str, str]] | None = None,
        dependency_rows: list[tuple[UUID, UUID, str]] | None = None,
        event_rows: list[tuple[str, datetime, Decimal | None]] | None = None,
    ) -> None:
        self.schedule = schedule
        self.simulation = simulation
        self.entry_rows = ENTRY_ROWS if entry_rows is None else entry_rows
        self.dependency_rows = DEPENDENCY_ROWS if dependency_rows is None else dependency_rows
        self.event_rows = event_rows if event_rows is not None else []
        self.added: list[Any] = []
        self.flushes = 0

    def begin(self) -> FakeTransaction:
        return FakeTransaction()

    def add(self, item: Any) -> None:
        self.added.append(item)
        # A real flush populates the Python-side UUID default and makes the row
        # visible to later reads in the same transaction; mirror both.
        if getattr(item, "id", None) is None:
            item.id = uuid4()
        if type(item).__name__ == "Simulation":
            self.simulation = item

    async def flush(self) -> None:
        self.flushes += 1

    async def execute(self, statement: Any) -> "FakeResult":
        rendered = str(statement)
        if "FROM schedules" in rendered:
            return FakeResult(scalar=self.schedule)
        if "FROM simulations" in rendered:
            return FakeResult(scalar=self.simulation)
        if "FROM simulation_events" in rendered:
            return FakeResult(rows=self.event_rows)
        if "FROM schedule_dependencies" in rendered:
            return FakeResult(rows=self.dependency_rows)
        if "FROM schedule_entries" in rendered:
            return FakeResult(rows=self.entry_rows)
        raise AssertionError(f"Unexpected query: {rendered}")


class FakeResult:
    def __init__(self, *, scalar: Any = None, rows: list[Any] | None = None) -> None:
        self._scalar = scalar
        self._rows = rows or []

    def scalar_one_or_none(self) -> Any:
        return self._scalar

    def tuples(self) -> "FakeResult":
        return self

    def all(self) -> list[Any]:
        return self._rows


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def timeline_of(
    entry_rows: list[tuple[UUID, UUID, UUID, int, str, str, str]] = ENTRY_ROWS,
    dependency_rows: list[tuple[UUID, UUID, str]] = DEPENDENCY_ROWS,
) -> Any:
    return FloorSyncScheduleAdapter.build_timeline(
        FloorSyncScheduleAdapter.entries_from_rows(entry_rows),
        FloorSyncScheduleAdapter.dependencies_from_rows(dependency_rows),
    )


# -- control transition rules --------------------------------------------


@pytest.mark.parametrize(
    ("event_type", "status", "expected"),
    [
        (SimulationEventType.STARTED, "not_started", True),
        (SimulationEventType.STARTED, "running", False),
        (SimulationEventType.PAUSED, "running", True),
        (SimulationEventType.PAUSED, "paused", False),
        (SimulationEventType.RESUMED, "paused", True),
        (SimulationEventType.RESUMED, "not_started", False),
        (SimulationEventType.SPEED_CHANGED, "running", True),
        (SimulationEventType.SPEED_CHANGED, "paused", True),
        (SimulationEventType.SPEED_CHANGED, "complete", False),
        (SimulationEventType.RESET, "complete", True),
        (SimulationEventType.COMPLETED, "running", True),
        (SimulationEventType.COMPLETED, "paused", False),
    ],
)
def test_control_transitions(event_type: SimulationEventType, status: str, expected: bool) -> None:
    assert control_is_applicable(event_type, status) is expected


def test_only_speed_setting_controls_require_a_speed() -> None:
    assert control_requires_speed(SimulationEventType.STARTED)
    assert control_requires_speed(SimulationEventType.RESUMED)
    assert control_requires_speed(SimulationEventType.SPEED_CHANGED)
    assert not control_requires_speed(SimulationEventType.PAUSED)
    assert not control_requires_speed(SimulationEventType.RESET)


# -- timeline service ----------------------------------------------------


def test_get_timeline_resolves_stored_rows() -> None:
    session = FakeSession(schedule=FakeSchedule())

    result = run(ScheduleTimelineService.get_timeline(session, schedule_id=SCHEDULE_ID))

    assert isinstance(result, TimelineResolved)
    assert result.timeline.makespan == 5
    placements = {
        item.operation_label: (item.start_time, item.end_time)
        for item in result.timeline.operations
    }
    assert placements == {"Cut": (0, 3), "Polish": (3, 5)}


def test_get_timeline_reports_a_missing_schedule() -> None:
    session = FakeSession(schedule=None)

    result = run(ScheduleTimelineService.get_timeline(session, schedule_id=SCHEDULE_ID))

    assert result == ScheduleNotFound(schedule_id=SCHEDULE_ID)


def test_get_timeline_reports_a_schedule_with_no_entries() -> None:
    session = FakeSession(schedule=FakeSchedule(), entry_rows=[])

    result = run(ScheduleTimelineService.get_timeline(session, schedule_id=SCHEDULE_ID))

    assert result == ScheduleNotGenerated(schedule_id=SCHEDULE_ID)


# -- creating a simulation -----------------------------------------------


def test_create_simulation_requires_a_confirmed_schedule() -> None:
    session = FakeSession(schedule=FakeSchedule(status="draft"))

    result = run(SimulationService.create_simulation(session, schedule_id=SCHEDULE_ID))

    assert result == ScheduleNotConfirmed(schedule_id=SCHEDULE_ID, status="draft")
    assert session.added == []


def test_create_simulation_reports_an_existing_one() -> None:
    session = FakeSession(schedule=FakeSchedule(), simulation=FakeSimulation())

    result = run(SimulationService.create_simulation(session, schedule_id=SCHEDULE_ID))

    assert result == SimulationAlreadyExists(schedule_id=SCHEDULE_ID, simulation_id=SIMULATION_ID)
    assert session.added == []


def test_create_simulation_adds_a_not_started_row() -> None:
    session = FakeSession(schedule=FakeSchedule(), simulation=None)

    result = run(SimulationService.create_simulation(session, schedule_id=SCHEDULE_ID))

    assert isinstance(result, SimulationCreated)
    assert result.simulation.status == "not_started"
    assert result.simulation.speed == Decimal("1")
    assert session.flushes == 1


def test_create_simulation_reports_a_missing_schedule() -> None:
    session = FakeSession(schedule=None)

    result = run(SimulationService.create_simulation(session, schedule_id=SCHEDULE_ID))

    assert result == ScheduleNotFound(schedule_id=SCHEDULE_ID)


# -- reading a position --------------------------------------------------


def test_get_simulation_derives_position_from_the_event_log() -> None:
    session = FakeSession(
        schedule=FakeSchedule(),
        simulation=FakeSimulation(status="running"),
        event_rows=[("started", NOW, Decimal("1"))],
    )

    result = run(
        SimulationService.get_simulation(
            session, simulation_id=SIMULATION_ID, at=NOW + timedelta(seconds=2)
        )
    )

    assert isinstance(result, SimulationPositionResolved)
    assert result.position.time == pytest.approx(2.0)
    assert result.position.is_running is True
    assert result.makespan == 5


def test_get_simulation_reports_a_missing_simulation() -> None:
    session = FakeSession(simulation=None)

    result = run(SimulationService.get_simulation(session, simulation_id=SIMULATION_ID))

    assert result == SimulationNotFound(simulation_id=SIMULATION_ID)


def test_get_simulation_clamps_at_the_makespan() -> None:
    session = FakeSession(
        schedule=FakeSchedule(),
        simulation=FakeSimulation(status="running"),
        event_rows=[("started", NOW, Decimal("1"))],
    )

    result = run(
        SimulationService.get_simulation(
            session, simulation_id=SIMULATION_ID, at=NOW + timedelta(minutes=5)
        )
    )

    assert isinstance(result, SimulationPositionResolved)
    assert result.position.time == 5
    assert result.position.is_complete is True


# -- recording control actions -------------------------------------------


def test_record_control_appends_an_event_and_projects_status() -> None:
    simulation = FakeSimulation(status="not_started")
    session = FakeSession(schedule=FakeSchedule(), simulation=simulation)

    result = run(
        SimulationService.record_control(
            session,
            simulation_id=SIMULATION_ID,
            event_type=SimulationEventType.STARTED,
            speed=Decimal("2"),
            at=NOW,
        )
    )

    assert isinstance(result, ControlRecorded)
    assert len(session.added) == 1
    assert session.added[0].event_type == "started"
    assert session.added[0].occurred_at == NOW
    assert session.added[0].speed == Decimal("2")
    assert simulation.status == "running"
    assert simulation.started_at == NOW
    assert simulation.speed == Decimal("2")


def test_record_control_rejects_an_inapplicable_transition() -> None:
    session = FakeSession(schedule=FakeSchedule(), simulation=FakeSimulation(status="not_started"))

    result = run(
        SimulationService.record_control(
            session, simulation_id=SIMULATION_ID, event_type=SimulationEventType.PAUSED, at=NOW
        )
    )

    assert result == ControlNotApplicable(
        simulation_id=SIMULATION_ID,
        event_type=SimulationEventType.PAUSED,
        status="not_started",
    )
    assert session.added == []


def test_record_control_requires_a_speed_where_one_is_set() -> None:
    session = FakeSession(schedule=FakeSchedule(), simulation=FakeSimulation(status="not_started"))

    result = run(
        SimulationService.record_control(
            session, simulation_id=SIMULATION_ID, event_type=SimulationEventType.STARTED, at=NOW
        )
    )

    assert result == ControlSpeedRequired(
        simulation_id=SIMULATION_ID, event_type=SimulationEventType.STARTED
    )
    assert session.added == []


def test_record_control_reset_clears_the_projection() -> None:
    simulation = FakeSimulation(status="running")
    simulation.started_at = NOW
    session = FakeSession(schedule=FakeSchedule(), simulation=simulation)

    result = run(
        SimulationService.record_control(
            session, simulation_id=SIMULATION_ID, event_type=SimulationEventType.RESET, at=NOW
        )
    )

    assert isinstance(result, ControlRecorded)
    assert simulation.status == "not_started"
    assert simulation.started_at is None


# -- schema mapping ------------------------------------------------------


def test_timeline_response_separates_lanes_from_operations() -> None:
    payload = TimelineResponse.from_timeline(SCHEDULE_ID, timeline_of()).model_dump()

    assert payload["schedule_id"] == SCHEDULE_ID
    assert payload["makespan"] == 5
    assert [lane["label"] for lane in payload["machines"]] == ["Cutter", "Polisher"]
    assert [lane["label"] for lane in payload["jobs"]] == ["Frame"]
    assert payload["operations"][0] == {
        "key": str(CUT),
        "job_key": str(FRAME),
        "machine_key": str(CUTTER),
        "label": "Cut",
        "start": 0,
        "end": 3,
        "machine_slot": 0,
    }


# -- routes --------------------------------------------------------------


def build_client(session: FakeSession, *, role: str = "manager") -> TestClient:
    """Mount the simulation router with the session and current user overridden."""
    app = FastAPI()
    install_problem_handlers(app)
    app.include_router(simulation_router, prefix="/api/v1")

    class FakeUser:
        def __init__(self) -> None:
            self.id = uuid4()
            self.role = role
            self.machine_id = None

    user = FakeUser()
    app.dependency_overrides[get_db_session] = lambda: session
    app.dependency_overrides[get_current_user] = lambda: user
    # require_roles builds a new dependency per call, so override the callable it wraps.
    app.dependency_overrides[require_roles("manager")] = lambda: user
    return TestClient(app)


def test_timeline_route_returns_the_resolved_schedule() -> None:
    client = build_client(FakeSession(schedule=FakeSchedule()))

    response = client.get(f"/api/v1/schedules/{SCHEDULE_ID}/timeline")

    assert response.status_code == 200
    body = response.json()
    assert body["makespan"] == 5
    assert len(body["operations"]) == 2
    assert body["operations"][0]["label"] == "Cut"


def test_timeline_route_reports_a_missing_schedule_as_a_problem() -> None:
    client = build_client(FakeSession(schedule=None))

    response = client.get(f"/api/v1/schedules/{SCHEDULE_ID}/timeline")

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert str(SCHEDULE_ID) in response.json()["detail"]


def test_timeline_route_reports_an_ungenerated_schedule_as_a_conflict() -> None:
    client = build_client(FakeSession(schedule=FakeSchedule(), entry_rows=[]))

    response = client.get(f"/api/v1/schedules/{SCHEDULE_ID}/timeline")

    assert response.status_code == 409
    assert response.headers["content-type"] == "application/problem+json"


def test_simulation_route_returns_the_derived_position() -> None:
    client = build_client(
        FakeSession(
            schedule=FakeSchedule(),
            simulation=FakeSimulation(status="running"),
            event_rows=[("started", NOW, Decimal("1"))],
        )
    )

    response = client.get(f"/api/v1/simulations/{SIMULATION_ID}")

    assert response.status_code == 200
    body = response.json()
    assert body["makespan"] == 5
    assert body["status"] == "running"
    assert body["speed"] == "1"


def test_event_route_records_a_control_action() -> None:
    session = FakeSession(schedule=FakeSchedule(), simulation=FakeSimulation())
    client = build_client(session)

    response = client.post(
        f"/api/v1/simulations/{SIMULATION_ID}/events",
        json={"event_type": "started", "speed": "1.5"},
    )

    assert response.status_code == 201
    assert response.headers["location"] == f"/api/v1/simulations/{SIMULATION_ID}"
    assert len(session.added) == 1
    assert response.json()["status"] == "running"


def test_event_route_rejects_an_inapplicable_control() -> None:
    client = build_client(
        FakeSession(schedule=FakeSchedule(), simulation=FakeSimulation(status="not_started"))
    )

    response = client.post(
        f"/api/v1/simulations/{SIMULATION_ID}/events", json={"event_type": "paused"}
    )

    assert response.status_code == 409
    assert response.headers["content-type"] == "application/problem+json"


def test_event_route_rejects_an_unknown_control_before_reaching_the_service() -> None:
    client = build_client(FakeSession(schedule=FakeSchedule(), simulation=FakeSimulation()))

    response = client.post(
        f"/api/v1/simulations/{SIMULATION_ID}/events", json={"event_type": "teleported"}
    )

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:request-validation"


def test_event_route_rejects_unknown_fields() -> None:
    client = build_client(FakeSession(schedule=FakeSchedule(), simulation=FakeSimulation()))

    response = client.post(
        f"/api/v1/simulations/{SIMULATION_ID}/events",
        json={"event_type": "started", "speed": "1", "sneaky": True},
    )

    assert response.status_code == 422


def test_create_simulation_route_sets_a_location_header() -> None:
    client = build_client(FakeSession(schedule=FakeSchedule(), simulation=None))

    response = client.post("/api/v1/simulations", json={"schedule_id": str(SCHEDULE_ID)})

    assert response.status_code == 201
    assert response.headers["location"].startswith("/api/v1/simulations/")
