from collections.abc import Collection, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from gurobipy import GurobiError

from floorsync_common.scheduling import (
    ScheduleStored,
    SchedulingInput,
    SchedulingInputInvalid,
    SchedulingIssue,
)
from floorsync_common.scheduling.contracts import (
    DependencySpec,
    MachineSpec,
    OperationSpec,
    RouteSpec,
)
from floorsync_common.scheduling.gurobi_exact_solver import STRATEGY as EXACT_SOLVER_STRATEGY
from floorsync_common.scheduling.gurobi_exact_solver import NoFeasibleSchedule
from floorsync_workers.tasks import schedules


@contextmanager
def _fake_session_scope() -> Iterator[object]:
    yield object()


MACHINE_ID = uuid4()
OPERATION_ID = uuid4()


def _loaded_input() -> SchedulingInput:
    """The smallest thing `load_input` can hand back that the worker will pass on to the engine.

    A bare `object()` no longer works there: the worker matches the loaded result exhaustively and
    ends with `assert_never`, so an unknown stand-in is a failure rather than something passed
    through unexamined. It also has to be *coherent*: the worker runs the shared data validation
    before any engine (#133), so an empty floor would be refused as `no_operations` before the
    mocked engine ever saw it. One machine, one operation, one route is the least that passes.
    """

    return SchedulingInput(
        starts_at=datetime(2026, 9, 6, 8, tzinfo=UTC),
        machines=(MachineSpec(id=MACHINE_ID, active=True, salary_per_minute=None),),
        operations=(OperationSpec(id=OPERATION_ID, name="Cut"),),
        routes=(
            RouteSpec(
                operation_id=OPERATION_ID, machine_id=MACHINE_ID, duration_minutes=5, energy=None
            ),
        ),
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

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> SchedulingInput:
        assert transaction_open
        return _loaded_input()

    def adapt_scheduling_input(problem: SchedulingInput) -> tuple[object, ...]:
        assert problem is not None
        return ("operations", "eligible", "operation_data", "machine_meta")

    def solve_fajsp(
        operations: object,
        eligible_machines: object,
        operation_data: object,
        machine_meta: object,
        starts_at: datetime,
    ) -> tuple[object, int, bool, float]:
        assert not transaction_open
        assert operations == "operations"
        assert eligible_machines == "eligible"
        assert operation_data == "operation_data"
        assert machine_meta == "machine_meta"
        assert starts_at == datetime(2026, 9, 6, 8, tzinfo=UTC)
        return "plan", 1234, True, 0.0

    def store_draft(
        _: object,
        *,
        plan: object,
        runtime_ms: int,
        input_operation_count: int,
        strategy: str | None = None,
        job_ids: Collection[UUID] | None = None,
    ) -> ScheduleStored:
        assert transaction_open
        assert plan == "plan"
        assert runtime_ms == 1234
        assert input_operation_count == len("operation_data")
        assert strategy == EXACT_SOLVER_STRATEGY
        assert job_ids is None

        class _Schedule:
            id = stored_schedule_id

        return ScheduleStored(schedule=_Schedule())  # type: ignore[arg-type]

    monkeypatch.setattr(schedules, "worker_session_scope", fake_session_scope)
    monkeypatch.setattr(schedules.SchedulingService, "load_input", staticmethod(load_input))
    monkeypatch.setattr(schedules, "adapt_scheduling_input", adapt_scheduling_input)
    monkeypatch.setattr(schedules, "solve_fajsp", solve_fajsp)
    monkeypatch.setattr(schedules.SchedulingService, "store_draft", staticmethod(store_draft))

    result = schedules.generate_schedule_exact.run("2026-09-06T08:00:00+00:00")

    assert result == {
        "outcome": "stored",
        "schedule_id": str(stored_schedule_id),
        "proven_optimal": True,
        "gap": 0.0,
    }


def test_exact_worker_rejects_a_dependency_cycle_before_building_the_model(
    monkeypatch: Any,
) -> None:
    """Gurobi would report this as infeasible; the cycle is a clearer, more specific refusal.

    The floor is otherwise coherent (both operations have a route), so the cycle is the only
    thing the shared validation reports and the assertion below stays exact.
    """

    first, second = uuid4(), uuid4()

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> SchedulingInput:
        return SchedulingInput(
            starts_at=datetime(2026, 9, 6, 8, tzinfo=UTC),
            machines=(MachineSpec(id=MACHINE_ID, active=True, salary_per_minute=None),),
            operations=(OperationSpec(id=first, name="a"), OperationSpec(id=second, name="b")),
            routes=(
                RouteSpec(
                    operation_id=first, machine_id=MACHINE_ID, duration_minutes=5, energy=None
                ),
                RouteSpec(
                    operation_id=second, machine_id=MACHINE_ID, duration_minutes=5, energy=None
                ),
            ),
            dependencies=(
                DependencySpec(before_operation_id=first, after_operation_id=second),
                DependencySpec(before_operation_id=second, after_operation_id=first),
            ),
        )

    solved = False

    def solve_fajsp(*args: object) -> tuple[object, int, bool, float]:
        nonlocal solved
        solved = True
        raise AssertionError("the solver must not run on a cyclic instance")

    monkeypatch.setattr(schedules, "worker_session_scope", _fake_session_scope)
    monkeypatch.setattr(schedules.SchedulingService, "load_input", staticmethod(load_input))
    monkeypatch.setattr(schedules, "solve_fajsp", solve_fajsp)

    result = schedules.generate_schedule_exact.run("2026-09-06T08:00:00+00:00")

    assert not solved
    assert result["outcome"] == "invalid"
    issues = result["issues"]
    assert isinstance(issues, list)
    assert {issue["code"] for issue in issues} == {"cyclic_dependencies"}
    assert {issue["operation_id"] for issue in issues} == {str(first), str(second)}


def test_exact_worker_reports_an_infeasible_instance_as_invalid(monkeypatch: Any) -> None:
    """Gurobi finding no feasible schedule within the time budget rejects the run, not the task."""

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> SchedulingInput:
        return _loaded_input()

    def adapt_scheduling_input(problem: SchedulingInput) -> tuple[object, ...]:
        return ("operations", "eligible", "operation_data", "machine_meta")

    def solve_fajsp(*args: object) -> tuple[object, int, bool, float]:
        raise NoFeasibleSchedule("Gurobi found no feasible schedule within the 120s time limit.")

    monkeypatch.setattr(schedules, "worker_session_scope", _fake_session_scope)
    monkeypatch.setattr(schedules.SchedulingService, "load_input", staticmethod(load_input))
    monkeypatch.setattr(schedules, "adapt_scheduling_input", adapt_scheduling_input)
    monkeypatch.setattr(schedules, "solve_fajsp", solve_fajsp)

    result = schedules.generate_schedule_exact.run("2026-09-06T08:00:00+00:00")

    assert result == {
        "outcome": "invalid",
        "issues": [
            {
                "code": "infeasible",
                "message": "Gurobi found no feasible schedule within the 120s time limit.",
            }
        ],
    }


def test_exact_worker_reports_a_gurobi_license_failure_as_unavailable(monkeypatch: Any) -> None:
    """A missing or rejected license is the engine being down, not the input being unsolvable."""

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> SchedulingInput:
        return _loaded_input()

    def adapt_scheduling_input(problem: SchedulingInput) -> tuple[object, ...]:
        return ("operations", "eligible", "operation_data", "machine_meta")

    def solve_fajsp(*args: object) -> tuple[object, int, bool, float]:
        raise GurobiError(10009, "No Gurobi license found")

    monkeypatch.setattr(schedules, "worker_session_scope", _fake_session_scope)
    monkeypatch.setattr(schedules.SchedulingService, "load_input", staticmethod(load_input))
    monkeypatch.setattr(schedules, "adapt_scheduling_input", adapt_scheduling_input)
    monkeypatch.setattr(schedules, "solve_fajsp", solve_fajsp)

    result = schedules.generate_schedule_exact.run("2026-09-06T08:00:00+00:00")

    assert result == {"outcome": "unavailable"}


def test_exact_worker_passes_the_selection_to_load_input_and_store_draft(monkeypatch: Any) -> None:
    """The exact solver scopes to a selection exactly like `generate_schedule` does (#231)."""

    job_id = uuid4()
    seen_by_load_input: list[Collection[UUID] | None] = []
    seen_by_store_draft: list[Collection[UUID] | None] = []

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> SchedulingInput:
        seen_by_load_input.append(job_ids)
        return _loaded_input()

    def adapt_scheduling_input(problem: SchedulingInput) -> tuple[object, ...]:
        return ("operations", "eligible", "operation_data", "machine_meta")

    def solve_fajsp(*args: object) -> tuple[object, int, bool, float]:
        return "plan", 1, True, 0.0

    def store_draft(
        _: object,
        *,
        plan: object,
        runtime_ms: int,
        input_operation_count: int,
        strategy: str | None = None,
        job_ids: Collection[UUID] | None = None,
    ) -> ScheduleStored:
        seen_by_store_draft.append(job_ids)

        class _Schedule:
            id = uuid4()

        return ScheduleStored(schedule=_Schedule())  # type: ignore[arg-type]

    monkeypatch.setattr(schedules, "worker_session_scope", _fake_session_scope)
    monkeypatch.setattr(schedules.SchedulingService, "load_input", staticmethod(load_input))
    monkeypatch.setattr(schedules, "adapt_scheduling_input", adapt_scheduling_input)
    monkeypatch.setattr(schedules, "solve_fajsp", solve_fajsp)
    monkeypatch.setattr(schedules.SchedulingService, "store_draft", staticmethod(store_draft))

    schedules.generate_schedule_exact.run("2026-09-06T08:00:00+00:00", [str(job_id)])

    assert seen_by_load_input == [[job_id]]
    assert seen_by_store_draft == [[job_id]]


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


def test_resched_worker_refuses_incoherent_data_before_the_engine_runs(monkeypatch: Any) -> None:
    """Shared validation (#133) runs first, so both strategies refuse a bad floor the same way."""

    machine = MachineSpec(id=MACHINE_ID, active=False, salary_per_minute=None)
    problem = SchedulingInput(
        starts_at=datetime(2026, 9, 6, 8, tzinfo=UTC),
        machines=(machine,),
        operations=(OperationSpec(id=OPERATION_ID, name="Cut"),),
        routes=(
            RouteSpec(
                operation_id=OPERATION_ID, machine_id=MACHINE_ID, duration_minutes=5, energy=None
            ),
        ),
        dependencies=(),
    )

    def load_input(
        _: object, *, starts_at: datetime, job_ids: Collection[UUID] | None = None
    ) -> SchedulingInput:
        return problem

    def generate(_: object) -> object:
        raise AssertionError("the engine must not run on an incoherent floor")

    monkeypatch.setattr(schedules, "worker_session_scope", _fake_session_scope)
    monkeypatch.setattr(schedules.SchedulingService, "load_input", staticmethod(load_input))
    monkeypatch.setattr(schedules.ReSchedEngine, "generate", staticmethod(generate))

    result = schedules.generate_schedule.run("2026-09-06T08:00:00+00:00")

    assert result["outcome"] == "invalid"
    issues = result["issues"]
    assert isinstance(issues, list)
    assert issues == [
        {
            "code": "no_compatible_machine",
            "message": "Operation has no active compatible machine.",
            "operation_id": str(OPERATION_ID),
        }
    ]
