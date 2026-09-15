"""Asynchronous scheduling tasks."""

from datetime import datetime
from time import perf_counter_ns
from typing import assert_never
from uuid import UUID

from floorsync_common.scheduling import (
    ReSchedEngine,
    ReSchedRuntimeUnavailable,
    ScheduleGenerated,
    SchedulingInput,
    SchedulingInputInvalid,
    SchedulingService,
)
from floorsync_common.scheduling.gurobi_exact_solver import STRATEGY as EXACT_SOLVER_STRATEGY
from floorsync_common.scheduling.gurobi_exact_solver import solve_fajsp
from floorsync_common.scheduling.load_data_from_db import load_fajsp_from_db
from floorsync_common.scheduling.task_names import (
    EXACT_SCHEDULE_GENERATION_TASK,
    SCHEDULE_GENERATION_TASK,
)
from floorsync_workers.celery_app import celery_app
from floorsync_workers.database import worker_session_scope


def _issues_payload(result: SchedulingInputInvalid) -> list[dict[str, str]]:
    return [
        {
            "code": issue.code,
            "message": issue.message,
            **({"operation_id": str(issue.operation_id)} if issue.operation_id is not None else {}),
            **({"machine_id": str(issue.machine_id)} if issue.machine_id is not None else {}),
            **({"job_id": str(issue.job_id)} if issue.job_id is not None else {}),
        }
        for issue in result.issues
    ]


@celery_app.task(name=SCHEDULE_GENERATION_TASK, queue="scheduling")  # type: ignore[untyped-decorator]
def generate_schedule(starts_at: str, job_ids: list[str] | None = None) -> dict[str, object]:
    """Generate and persist a draft without holding a database transaction during inference.

    `job_ids` arrives as strings because a Celery argument has to survive JSON. It defaults to
    `None`, so a task queued by an API that predates #231 still means the whole floor and no
    in-flight message is invalidated by this deploy.
    """

    selection = [UUID(job_id) for job_id in job_ids] if job_ids is not None else None

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


@celery_app.task(name=EXACT_SCHEDULE_GENERATION_TASK, queue="scheduling")  # type: ignore[untyped-decorator]
def generate_schedule_exact(starts_at: str) -> dict[str, object]:
    """Generate and persist a draft with the exact Gurobi solver.

    Loading and storing each run in their own transaction, same as
    `generate_schedule`, so the database connection isn't held for the
    duration of `model.optimize()`. A floor with no schedulable operations, or
    an instance Gurobi can't solve within its time budget, is reported as a
    rejected generation the same way `generate_schedule` reports a
    `SchedulingInputInvalid` input, rather than crashing the task.
    """
    parsed_starts_at = datetime.fromisoformat(starts_at)

    try:
        with worker_session_scope() as db:
            _jobs, _machines, operations, eligible_machines, operation_data, machine_meta = (
                load_fajsp_from_db(db)
            )
    except ValueError as exc:
        return {
            "outcome": "invalid",
            "issues": [{"code": "no_compatible_machine", "message": str(exc)}],
        }

    try:
        plan, runtime_ms = solve_fajsp(
            operations,
            eligible_machines,
            operation_data,
            machine_meta,
            parsed_starts_at,
        )
    except RuntimeError as exc:
        return {"outcome": "invalid", "issues": [{"code": "infeasible", "message": str(exc)}]}

    with worker_session_scope() as db:
        stored = SchedulingService.store_draft(
            db,
            plan=plan,
            runtime_ms=runtime_ms,
            input_operation_count=len(operation_data),
            strategy=EXACT_SOLVER_STRATEGY,
        )
    return {"outcome": "stored", "schedule_id": str(stored.schedule.id)}
