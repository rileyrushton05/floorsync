from collections.abc import AsyncIterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, cast
from uuid import UUID, uuid4

from celery.exceptions import OperationalError
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_api.features.schedules import router as schedules_router
from floorsync_common.database.models.schedule import Schedule
from floorsync_common.database.models.schedule_dependency import ScheduleDependency
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.user import User
from floorsync_common.scheduling.task_names import (
    EXACT_SCHEDULE_GENERATION_TASK,
    SCHEDULE_GENERATION_TASK,
)
from floorsync_common.settings import Settings


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(
        self,
        exception_type: object,
        exception: object,
        traceback: object,
    ) -> None:
        return None


class FakeScalars:
    def __init__(self, values: list[object]) -> None:
        self._values = values

    def all(self) -> list[object]:
        return self._values


class FakeScheduleSession:
    def __init__(
        self,
        schedule: Schedule | None = None,
        entries: list[ScheduleEntry] | None = None,
        dependencies: list[ScheduleDependency] | None = None,
    ) -> None:
        self.schedule = schedule
        self.entries = entries or []
        self.dependencies = dependencies or []
        self._scalar_calls = 0

    def begin(self) -> FakeTransaction:
        return FakeTransaction()

    async def get(self, _: type[Schedule], __: UUID) -> Schedule | None:
        return self.schedule

    async def scalars(self, _: object) -> FakeScalars:
        self._scalar_calls += 1
        values: list[object] = self.entries if self._scalar_calls == 1 else self.dependencies
        return FakeScalars(values)


class FakeQueuedTask:
    def __init__(self, task_id: UUID) -> None:
        self.id = str(task_id)


class FakeTaskResult:
    def __init__(self, state: str, result: object) -> None:
        self.state = state
        self.result = result


class FakeTaskQueue:
    def __init__(self, task_result: FakeTaskResult | None = None) -> None:
        self.task_id = uuid4()
        self.task_result = task_result or FakeTaskResult("PENDING", None)
        self.sent: tuple[str, tuple[str, ...], str] | None = None
        self.failure: Exception | None = None

    def send_task(self, name: str, *, args: tuple[str, ...], queue: str) -> FakeQueuedTask:
        if self.failure is not None:
            raise self.failure
        self.sent = (name, args, queue)
        return FakeQueuedTask(self.task_id)

    def AsyncResult(self, _: str) -> FakeTaskResult:
        if self.failure is not None:
            raise self.failure
        return self.task_result


def schedule_application(user: User, session: FakeScheduleSession) -> FastAPI:
    from floorsync_api.main import create_application

    application = create_application(Settings(environment="test"))

    async def get_test_db_session() -> AsyncIterator[AsyncSession]:
        yield cast(AsyncSession, session)

    async def get_test_current_user() -> User:
        return user

    application.dependency_overrides[get_db_session] = get_test_db_session
    application.dependency_overrides[get_current_user] = get_test_current_user
    return application


def schedule_fixture() -> tuple[Schedule, ScheduleEntry, ScheduleDependency]:
    schedule_id = uuid4()
    entry_id = uuid4()
    created_at = datetime(2026, 9, 6, 8, tzinfo=UTC)
    schedule = Schedule(
        id=schedule_id,
        status="draft",
        strategy="resched_reinforce_v1",
        runtime_ms=42,
        input_operation_count=1,
        makespan=15,
        total_energy=Decimal("2.50"),
        total_labour_cost=Decimal("45.00"),
        created_at=created_at,
        updated_at=created_at,
    )
    entry = ScheduleEntry(
        id=entry_id,
        schedule_id=schedule_id,
        operation_id=uuid4(),
        machine_id=uuid4(),
        duration=15,
        energy=Decimal("2.50"),
        machine_salary=Decimal("3.00"),
    )
    dependency = ScheduleDependency(
        id=uuid4(),
        schedule_entry_id=entry_id,
        depends_on_schedule_entry_id=uuid4(),
        reason="machine_queue",
    )
    return schedule, entry, dependency


def test_manager_can_queue_schedule_generation(monkeypatch: Any) -> None:
    queue = FakeTaskQueue()
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).post(
        "/api/v1/schedules", json={"starts_at": "2026-09-06T08:00:00Z"}
    )

    expected_status_url = f"/api/v1/schedules/generations/{queue.task_id}"
    assert response.status_code == 202
    assert response.headers["location"] == expected_status_url
    assert response.json() == {
        "id": str(queue.task_id),
        "status": "pending",
        "status_url": expected_status_url,
    }
    assert queue.sent == (
        SCHEDULE_GENERATION_TASK,
        ("2026-09-06T08:00:00+00:00", None),
        "scheduling",
    )


def test_manager_can_request_the_exact_strategy(monkeypatch: Any) -> None:
    queue = FakeTaskQueue()
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).post(
        "/api/v1/schedules",
        json={"starts_at": "2026-09-06T08:00:00Z", "strategy": "exact"},
    )

    assert response.status_code == 202
    assert queue.sent == (
        EXACT_SCHEDULE_GENERATION_TASK,
        ("2026-09-06T08:00:00+00:00", None),
        "scheduling",
    )


def test_omitting_job_ids_still_queues_a_whole_floor_run(monkeypatch: Any) -> None:
    """The selection is optional, so #231 changes no existing caller's behaviour."""

    queue = FakeTaskQueue()
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).post(
        "/api/v1/schedules", json={"starts_at": "2026-09-06T08:00:00Z"}
    )

    assert response.status_code == 202
    assert queue.sent is not None
    assert queue.sent[1][1] is None


def test_queued_generation_carries_the_selected_jobs(monkeypatch: Any) -> None:
    """The selection reaches the worker as strings: a Celery argument has to survive JSON."""

    queue = FakeTaskQueue()
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")
    first, second = uuid4(), uuid4()

    response = TestClient(schedule_application(manager, FakeScheduleSession())).post(
        "/api/v1/schedules",
        json={"starts_at": "2026-09-06T08:00:00Z", "job_ids": [str(first), str(second)]},
    )

    assert response.status_code == 202
    assert queue.sent == (
        SCHEDULE_GENERATION_TASK,
        ("2026-09-06T08:00:00+00:00", [str(first), str(second)]),
        "scheduling",
    )


def test_a_job_selection_reaches_the_exact_solver_task_too(monkeypatch: Any) -> None:
    """Both engines load through the same `SchedulingService.load_input`, so scoping isn't
    resched-only."""

    queue = FakeTaskQueue()
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")
    job_id = uuid4()

    response = TestClient(schedule_application(manager, FakeScheduleSession())).post(
        "/api/v1/schedules",
        json={
            "starts_at": "2026-09-06T08:00:00Z",
            "strategy": "exact",
            "job_ids": [str(job_id)],
        },
    )

    assert response.status_code == 202
    assert queue.sent == (
        EXACT_SCHEDULE_GENERATION_TASK,
        ("2026-09-06T08:00:00+00:00", [str(job_id)]),
        "scheduling",
    )


def test_an_empty_selection_is_queued_rather_than_refused_at_the_edge(monkeypatch: Any) -> None:
    """This endpoint reads no database, so every selection refusal belongs to the worker.

    An empty list is a selection that selects nothing, not an omitted selection, and the difference
    has to survive the queue: the worker reports it as `empty_selection` rather than planning the
    whole floor.
    """

    queue = FakeTaskQueue()
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).post(
        "/api/v1/schedules", json={"starts_at": "2026-09-06T08:00:00Z", "job_ids": []}
    )

    assert response.status_code == 202
    assert queue.sent is not None
    assert queue.sent[1][1] == []


def test_operator_cannot_queue_schedule_generation(monkeypatch: Any) -> None:
    queue = FakeTaskQueue()
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    operator = User(id=uuid4(), name="Operator", role="operator", machine_id=uuid4())

    response = TestClient(schedule_application(operator, FakeScheduleSession())).post(
        "/api/v1/schedules", json={"starts_at": "2026-09-06T08:00:00Z"}
    )

    assert response.status_code == 403
    assert queue.sent is None


def test_broker_outage_returns_a_problem_detail(monkeypatch: Any) -> None:
    queue = FakeTaskQueue()
    queue.failure = OperationalError("offline")
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).post(
        "/api/v1/schedules", json={"starts_at": "2026-09-06T08:00:00Z"}
    )

    assert response.status_code == 503
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["instance"] == "/api/v1/schedules"


def test_completed_generation_links_to_its_schedule(monkeypatch: Any) -> None:
    schedule_id = uuid4()
    queue = FakeTaskQueue(
        FakeTaskResult("SUCCESS", {"outcome": "stored", "schedule_id": str(schedule_id)})
    )
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).get(
        f"/api/v1/schedules/generations/{queue.task_id}"
    )

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert response.json()["schedule_url"] == f"/api/v1/schedules/{schedule_id}"


def test_rejected_generation_exposes_its_input_issues(monkeypatch: Any) -> None:
    queue = FakeTaskQueue(
        FakeTaskResult(
            "SUCCESS",
            {
                "outcome": "invalid",
                "issues": [
                    {
                        "code": "unsupported_unavailability",
                        "message": "ReSched does not model downtime.",
                    }
                ],
            },
        )
    )
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).get(
        f"/api/v1/schedules/generations/{queue.task_id}"
    )

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"
    assert response.json()["issues"] == [
        {"code": "unsupported_unavailability", "message": "ReSched does not model downtime."}
    ]


def test_a_refused_selection_names_the_job_it_is_about(monkeypatch: Any) -> None:
    """A selection refusal has to be actionable: the backlog marks a row, it does not read prose."""

    job_id = uuid4()
    queue = FakeTaskQueue(
        FakeTaskResult(
            "SUCCESS",
            {
                "outcome": "invalid",
                "issues": [
                    {
                        "code": "unscheduled_prerequisite_job",
                        "message": "A selected job waits on this one.",
                        "job_id": str(job_id),
                    }
                ],
            },
        )
    )
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).get(
        f"/api/v1/schedules/generations/{queue.task_id}"
    )

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"
    assert response.json()["issues"][0]["code"] == "unscheduled_prerequisite_job"
    assert response.json()["issues"][0]["job_id"] == str(job_id)


def test_failed_generation_exposes_a_safe_api_detail(monkeypatch: Any) -> None:
    queue = FakeTaskQueue(FakeTaskResult("FAILURE", RuntimeError("database credentials leaked")))
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).get(
        f"/api/v1/schedules/generations/{queue.task_id}"
    )

    assert response.status_code == 200
    assert response.json() == {
        "id": str(queue.task_id),
        "status": "failed",
        "detail": schedules_router.SCHEDULING_GENERATION_FAILED_DETAIL,
    }
    assert "credentials" not in response.json()["detail"]


def test_unavailable_generation_exposes_a_safe_api_detail(monkeypatch: Any) -> None:
    queue = FakeTaskQueue(FakeTaskResult("SUCCESS", {"outcome": "unavailable"}))
    monkeypatch.setattr(schedules_router, "task_queue", queue)
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).get(
        f"/api/v1/schedules/generations/{queue.task_id}"
    )

    assert response.status_code == 200
    assert response.json() == {
        "id": str(queue.task_id),
        "status": "unavailable",
        "detail": schedules_router.SCHEDULING_ENGINE_UNAVAILABLE_DETAIL,
    }


def test_manager_can_read_a_saved_schedule() -> None:
    schedule, entry, dependency = schedule_fixture()
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(
        schedule_application(
            manager,
            FakeScheduleSession(schedule, entries=[entry], dependencies=[dependency]),
        )
    ).get(f"/api/v1/schedules/{schedule.id}")

    assert response.status_code == 200
    assert response.json()["id"] == str(schedule.id)
    assert response.json()["entries"][0]["duration"] == 15
    assert "starts_at" not in response.json()["entries"][0]


def test_reading_a_missing_schedule_returns_not_found() -> None:
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(schedule_application(manager, FakeScheduleSession())).get(
        f"/api/v1/schedules/{uuid4()}"
    )

    assert response.status_code == 404


class FakeScheduleListSession:
    """Answer one `scalars` call with the schedules a listing should return."""

    def __init__(self, schedules: list[Schedule]) -> None:
        self.schedules = schedules

    def begin(self) -> FakeTransaction:
        return FakeTransaction()

    async def scalars(self, _: object) -> FakeScalars:
        return FakeScalars(cast(list[object], self.schedules))


def test_manager_can_list_schedules() -> None:
    """The only route that reveals a schedule's id to a client that has none."""
    schedule, _, _ = schedule_fixture()
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(
        schedule_application(manager, cast(Any, FakeScheduleListSession([schedule])))
    ).get("/api/v1/schedules")

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["id"] == str(schedule.id)
    assert body[0]["status"] == "draft"
    assert body[0]["strategy"] == "resched_reinforce_v1"
    assert body[0]["makespan"] == 15


def test_listing_schedules_omits_their_entries() -> None:
    """Entries run to hundreds of rows per schedule, so a summary carries none."""
    schedule, _, _ = schedule_fixture()
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(
        schedule_application(manager, cast(Any, FakeScheduleListSession([schedule])))
    ).get("/api/v1/schedules")

    assert "entries" not in response.json()[0]
    assert "dependencies" not in response.json()[0]


def test_listing_schedules_is_empty_before_anything_is_scheduled() -> None:
    manager = User(id=uuid4(), name="Manager", role="manager")

    response = TestClient(
        schedule_application(manager, cast(Any, FakeScheduleListSession([])))
    ).get("/api/v1/schedules")

    assert response.status_code == 200
    assert response.json() == []


def test_operator_cannot_list_schedules() -> None:
    schedule, _, _ = schedule_fixture()
    operator = User(id=uuid4(), name="Operator", role="operator")

    response = TestClient(
        schedule_application(operator, cast(Any, FakeScheduleListSession([schedule])))
    ).get("/api/v1/schedules")

    assert response.status_code == 403
