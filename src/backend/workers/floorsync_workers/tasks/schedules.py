"""Asynchronous scheduling tasks."""

from datetime import datetime
from time import perf_counter_ns
from typing import assert_never
from uuid import UUID

from gurobipy import GurobiError

from floorsync_common.scheduling import (
    ReSchedEngine,
    ReSchedRuntimeUnavailable,
    ScheduleGenerated,
    SchedulingInput,
    SchedulingInputInvalid,
    SchedulingService,
)
from floorsync_common.scheduling.gurobi_exact_solver import STRATEGY as EXACT_SOLVER_STRATEGY
from floorsync_common.scheduling.gurobi_exact_solver import TIME_LIMIT_SECONDS as EXACT_TIME_LIMIT
from floorsync_common.scheduling.gurobi_exact_solver import (
    NoFeasibleSchedule,
    adapt_scheduling_input,
    solve_fajsp,
)
from floorsync_common.scheduling.input_checks import validate_for_strategy
from floorsync_common.scheduling.task_names import (
    EXACT_SCHEDULE_GENERATION_TASK,
    SCHEDULE_GENERATION_TASK,
)
from floorsync_workers.celery_app import celery_app
from floorsync_workers.database import worker_session_scope

# Celery's own limits sit above Gurobi's `TimeLimit`, so a hung solve or a stalled database call is
# still bounded even if Gurobi itself never returns: `soft_time_limit` gives the task a chance to
# raise cleanly once the solve should already be done, `time_limit` is the last-resort hard kill.
_EXACT_SOFT_TIME_LIMIT = EXACT_TIME_LIMIT + 30
_EXACT_HARD_TIME_LIMIT = EXACT_TIME_LIMIT + 45


def _issues_payload(result: SchedulingInputInvalid) -> list[dict[str, str]]:
    return [
        {
            "code": issue.code,
            "message": issue.message,
            **({"operation_id": str(issue.operation_id)} if issue.operation_id is not None else {}),
            **({"machine_id": str(issue.machine_id)} if issue.machine_id is not None else {}),
            **({"job_id": str(issue.job_id)} if issue.job_id is not None else {}),
            **({"schedule_id": str(issue.schedule_id)} if issue.schedule_id is not None else {}),
        }
        for issue in result.issues
    ]


@celery_app.task(name=SCHEDULE_GENERATION_TASK, queue="scheduling")  # type: ignore[untyped-decorator]
def generate_schedule(starts_at: str, job_ids: list[str]) -> dict[str, object]:
    """Generate and persist a draft without holding a database transaction during inference.

    `job_ids` arrives as strings because a Celery argument has to survive JSON. It is the
    manager's selection and is required (#270): a run always plans a chosen part of the backlog.
    """

    selection = [UUID(job_id) for job_id in job_ids]

    with worker_session_scope() as db:
        loaded = SchedulingService.load_input(
            db, starts_at=datetime.fromisoformat(starts_at), job_ids=selection
        )
    match loaded:
        case SchedulingInputInvalid():
            # A refused selection never reaches the engine: there is nothing to run it on.
            return {"outcome": "invalid", "issues": _issues_payload(loaded)}
        case SchedulingInput() as problem:
            pass
        case _:
            assert_never(loaded)

    # Refused here by the same checks the validation endpoint reports, data problems and this
    # strategy's limits alike, so the endpoint and the worker can never disagree (#133). The engine
    # re-checks its own limits inside `generate`; that is cheap and keeps it safe to call alone.
    invalid = validate_for_strategy(problem, "resched")
    if invalid is not None:
        return {"outcome": "invalid", "issues": _issues_payload(invalid)}

    started_ns = perf_counter_ns()
    result = ReSchedEngine.generate(problem)
    runtime_ms = (perf_counter_ns() - started_ns) // 1_000_000
    match result:
        case SchedulingInputInvalid():
            return {"outcome": "invalid", "issues": _issues_payload(result)}
        case ReSchedRuntimeUnavailable():
            return {"outcome": "unavailable"}
        case ScheduleGenerated(plan=plan):
            pass
        case _:
            assert_never(result)

    with worker_session_scope() as db:
        stored = SchedulingService.store_draft(
            db,
            plan=plan,
            runtime_ms=runtime_ms,
            input_operation_count=len(problem.operations),
            job_ids=selection,
        )
    return {"outcome": "stored", "schedule_id": str(stored.schedule.id)}


@celery_app.task(  # type: ignore[untyped-decorator]
    name=EXACT_SCHEDULE_GENERATION_TASK,
    queue="scheduling",
    soft_time_limit=_EXACT_SOFT_TIME_LIMIT,
    time_limit=_EXACT_HARD_TIME_LIMIT,
)
def generate_schedule_exact(starts_at: str, job_ids: list[str]) -> dict[str, object]:
    """Generate and persist a draft with the exact Gurobi solver.

    Loads through the same `SchedulingService.load_input` as `generate_schedule`, so `job_ids`
    scoping and its refusals (`unknown_job`, `empty_selection`, `planned_job`,
    `unscheduled_prerequisite_job`)
    behave identically regardless of which engine solves the result -- there is no second, exact-
    solver-only read path to keep in sync with #231's rules.

    Loading and storing each run in their own transaction, same as `generate_schedule`, so the
    database connection isn't held for the duration of `model.optimize()`. A dependency cycle is
    rejected before the model is even built: Gurobi would otherwise report the same instance as
    infeasible, which is indistinguishable from a genuinely hard but acyclic one. A missing or
    rejected Gurobi licence raises `GurobiError` rather than failing to find a feasible solution, so
    it is reported as `unavailable` instead -- the same outcome `generate_schedule` reports for
    `ReSchedRuntimeUnavailable`.
    """

    selection = [UUID(job_id) for job_id in job_ids]

    with worker_session_scope() as db:
        loaded = SchedulingService.load_input(
            db, starts_at=datetime.fromisoformat(starts_at), job_ids=selection
        )
    match loaded:
        case SchedulingInputInvalid():
            return {"outcome": "invalid", "issues": _issues_payload(loaded)}
        case SchedulingInput() as problem:
            pass
        case _:
            assert_never(loaded)

    # The exact solver has no guard of its own, so this is the only place its limits are enforced:
    # `adapt_scheduling_input` would otherwise drop downtime windows on the floor without a word.
    invalid = validate_for_strategy(problem, "exact")
    if invalid is not None:
        return {"outcome": "invalid", "issues": _issues_payload(invalid)}

    try:
        operations, eligible_machines, operation_data, machine_meta = adapt_scheduling_input(
            problem
        )
    except ValueError as exc:
        return {
            "outcome": "invalid",
            "issues": [{"code": "no_compatible_machine", "message": str(exc)}],
        }

    try:
        plan, runtime_ms, proven_optimal, gap = solve_fajsp(
            operations,
            eligible_machines,
            operation_data,
            machine_meta,
            problem.starts_at,
        )
    except NoFeasibleSchedule as exc:
        return {"outcome": "invalid", "issues": [{"code": "infeasible", "message": str(exc)}]}
    except GurobiError:
        return {"outcome": "unavailable"}

    with worker_session_scope() as db:
        stored = SchedulingService.store_draft(
            db,
            plan=plan,
            runtime_ms=runtime_ms,
            input_operation_count=len(operation_data),
            strategy=EXACT_SOLVER_STRATEGY,
            job_ids=selection,
        )
    return {
        "outcome": "stored",
        "schedule_id": str(stored.schedule.id),
        "proven_optimal": proven_optimal,
        "gap": gap,
    }
