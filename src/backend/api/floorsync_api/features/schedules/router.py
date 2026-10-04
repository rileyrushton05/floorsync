from typing import Annotated, Literal, assert_never
from uuid import UUID

from celery.exceptions import OperationalError
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import select

from floorsync_api.dependencies.authentication import require_roles
from floorsync_api.dependencies.database import DbSession
from floorsync_api.features.schedules.schemas import (
    ScheduleCreateRequest,
    ScheduleDependencyResponse,
    ScheduleEntryResponse,
    ScheduleGenerationAcceptedResponse,
    ScheduleGenerationStatusResponse,
    ScheduleResponse,
    ScheduleSummaryResponse,
    ScheduleUpdateRequest,
    ScheduleValidationResponse,
    SchedulingIssueResponse,
    StrategyLimitResponse,
)
from floorsync_api.problems import ProblemDetail, problem_response
from floorsync_common.database.models.schedule import Schedule
from floorsync_common.database.models.schedule_dependency import ScheduleDependency
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.user import User
from floorsync_common.scheduling.contracts import SchedulingIssue
from floorsync_common.scheduling.lifecycle import (
    ScheduleConfirmed,
    ScheduleDeleted,
    ScheduleDiscarded,
    ScheduleIsDraft,
    ScheduleLifecycleService,
    ScheduleNotDraft,
    ScheduleNotFound,
    ScheduleRenamed,
    ScheduleSimulationStarted,
)
from floorsync_common.scheduling.task_names import (
    EXACT_SCHEDULE_GENERATION_TASK,
    SCHEDULE_GENERATION_TASK,
)
from floorsync_common.scheduling.validation import ValidationService
from floorsync_common.task_queue import create_task_queue

router = APIRouter(prefix="/schedules", tags=["schedules"])
Manager = Annotated[User, Depends(require_roles("manager"))]
task_queue = create_task_queue()

_GENERATION_TASK_BY_STRATEGY = {
    "resched": SCHEDULE_GENERATION_TASK,
    "exact": EXACT_SCHEDULE_GENERATION_TASK,
}

SCHEDULING_ENGINE_UNAVAILABLE_DETAIL = (
    "The scheduling engine is unavailable for this run. "
    "Try again later or contact an administrator."
)
SCHEDULING_GENERATION_FAILED_DETAIL = (
    "The scheduling worker could not complete this run. "
    "Try again later or contact an administrator."
)


@router.post(
    "",
    response_model=ScheduleGenerationAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Queue draft schedule generation",
    responses={503: {"description": "Scheduling queue unavailable"}},
)
async def create_schedule(
    command: ScheduleCreateRequest,
    request: Request,
    response: Response,
    _: Manager,
) -> ScheduleGenerationAcceptedResponse | JSONResponse:
    """Queue draft generation without running the scheduling policy in the API process."""

    # The selection travels as strings because a Celery argument has to survive JSON, and is sent
    # unvalidated: checking it needs the dependency graph, and this endpoint reads no database at
    # all. Both tasks load through the same `SchedulingService.load_input`, so the worker refuses a
    # bad selection and the status resource reports it identically regardless of strategy.
    try:
        task = task_queue.send_task(
            _GENERATION_TASK_BY_STRATEGY[command.strategy],
            args=(
                command.starts_at.isoformat(),
                [str(job_id) for job_id in command.job_ids],
            ),
            queue="scheduling",
        )
    except OperationalError:
        return queue_unavailable_problem(request)

    generation_id = UUID(task.id)
    status_url = f"/api/v1/schedules/generations/{generation_id}"
    response.headers["Location"] = status_url
    return ScheduleGenerationAcceptedResponse(
        id=generation_id,
        status="pending",
        status_url=status_url,
    )


@router.get(
    "",
    response_model=list[ScheduleSummaryResponse],
    summary="List generated schedules",
)
async def list_schedules(db: DbSession, _: Manager) -> list[ScheduleSummaryResponse]:
    """List every schedule, newest first, without its entries.

    A caller that wants to open one has no other way to learn its identifier:
    generation reports an id only to whoever queued it, and a seeded schedule
    reports none at all. Summaries rather than full resources, because entries
    and dependencies run to hundreds of rows per schedule.
    """

    async with db.begin():
        schedules = (
            await db.scalars(
                select(Schedule).order_by(Schedule.created_at.desc(), Schedule.id.desc())
            )
        ).all()
    return [ScheduleSummaryResponse.model_validate(schedule) for schedule in schedules]


@router.get(
    "/generations/{generation_id}",
    response_model=ScheduleGenerationStatusResponse,
    response_model_exclude_none=True,
    summary="Get schedule-generation status",
)
async def get_schedule_generation(
    generation_id: UUID,
    request: Request,
    _: Manager,
) -> ScheduleGenerationStatusResponse | JSONResponse:
    """Read a queued command's state with safe API-authored terminal details."""

    try:
        task_result = task_queue.AsyncResult(str(generation_id))
        return schedule_generation_status(generation_id, task_result.state, task_result.result)
    except OperationalError:
        return queue_unavailable_problem(request)


# Declared before `/{schedule_id}`: FastAPI matches routes in declaration order, and the other way
# round this path is read as a schedule id and refused as a malformed UUID before reaching here.
@router.get(
    "/validation",
    response_model=ScheduleValidationResponse,
    summary="Check a job selection is ready to schedule",
)
async def validate_schedule_input(
    db: DbSession,
    _: Manager,
    job_ids: Annotated[list[UUID], Query(min_length=1)],
) -> ScheduleValidationResponse:
    """Report what would stop a generation run, before queueing one (#133).

    Reads the selection exactly as `POST /api/v1/schedules` would, refusals included, and runs
    the same data checks every strategy runs. `job_ids` is required for the same reason it is on
    generation (#270). Always `200`: a selection with problems is a successful answer to "what is
    wrong", and the report says per strategy whether Generate would succeed. Nothing is written.
    """

    async with db.begin():
        report = await ValidationService.validate_floor(db, job_ids=job_ids)

    return ScheduleValidationResponse(
        schedulable=dict(report.schedulable),
        issues=[_issue_response(issue) for issue in report.issues],
        warnings=[_issue_response(issue) for issue in report.warnings],
        unsupported=[
            StrategyLimitResponse(strategy=limit.strategy, issue=_issue_response(limit.issue))
            for limit in report.unsupported
        ],
    )


@router.get(
    "/{schedule_id}",
    response_model=ScheduleResponse,
    summary="Get a generated schedule",
)
async def get_schedule(schedule_id: UUID, db: DbSession, _: Manager) -> ScheduleResponse:
    """Fetch one immutable schedule version with its entries and dependency graph."""

    async with db.begin():
        schedule = await db.get(Schedule, schedule_id)
        if schedule is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Schedule not found.")
        entries = list(
            (
                await db.scalars(
                    select(ScheduleEntry)
                    .where(ScheduleEntry.schedule_id == schedule_id)
                    .order_by(ScheduleEntry.id)
                )
            ).all()
        )
        dependencies = list(
            (
                await db.scalars(
                    select(ScheduleDependency)
                    .join(
                        ScheduleEntry,
                        ScheduleDependency.schedule_entry_id == ScheduleEntry.id,
                    )
                    .where(ScheduleEntry.schedule_id == schedule_id)
                    .order_by(ScheduleDependency.id)
                )
            ).all()
        )
        return schedule_response(schedule, entries, dependencies)


@router.patch(
    "/{schedule_id}",
    response_model=ScheduleSummaryResponse,
    summary="Rename, confirm or discard a schedule",
    responses={
        404: {"description": "The schedule does not exist"},
        409: {
            "description": (
                "A draft cannot be discarded (delete it instead), or the schedule's simulation "
                "has started so it cannot be withdrawn"
            )
        },
    },
)
async def update_schedule(
    schedule_id: UUID,
    command: ScheduleUpdateRequest,
    request: Request,
    db: DbSession,
    manager: Manager,
) -> ScheduleSummaryResponse | JSONResponse:
    """Rename a schedule and/or move it through its lifecycle (decision 0015).

    `{"status": "confirmed"}` makes a draft the plan and records who confirmed it and when; on a
    discarded schedule it restores it. `{"status": "discarded"}` withdraws a confirmed schedule
    the floor has not acted on: a simulation created for it but never started is removed with it,
    one with any control recorded refuses the withdrawal. Neither touches the jobs the schedule
    planned; the backlog reads what a plan claims from the schedule itself (#269).

    `{"name": ...}` labels the schedule in any status. When both are sent the transition runs
    first, and a refused transition answers before anything is renamed.
    """

    async with db.begin():
        summary: ScheduleSummaryResponse | None = None
        if command.status is not None:
            match command.status:
                case "confirmed":
                    transitioned = await _confirm(db, schedule_id, manager)
                case "discarded":
                    transitioned = await _discard(db, schedule_id, request)
                case _:
                    assert_never(command.status)
            if isinstance(transitioned, JSONResponse):
                return transitioned
            summary = transitioned
        if command.name is not None:
            summary = await _rename(db, schedule_id, command.name)
        assert summary is not None, "the request schema requires a status or a name"
        return summary


async def _rename(db: DbSession, schedule_id: UUID, name: str) -> ScheduleSummaryResponse:
    result = await ScheduleLifecycleService.rename(db, schedule_id, name)
    match result:
        case ScheduleRenamed(schedule=schedule):
            return ScheduleSummaryResponse.model_validate(schedule)
        case ScheduleNotFound():
            raise _schedule_not_found()
        case _:
            assert_never(result)


async def _confirm(
    db: DbSession, schedule_id: UUID, manager: User
) -> ScheduleSummaryResponse | JSONResponse:
    result = await ScheduleLifecycleService.confirm(db, schedule_id, confirmed_by=manager.id)
    match result:
        case ScheduleConfirmed(schedule=schedule):
            return ScheduleSummaryResponse.model_validate(schedule)
        case ScheduleNotFound():
            raise _schedule_not_found()
        case _:
            assert_never(result)


async def _discard(
    db: DbSession, schedule_id: UUID, request: Request
) -> ScheduleSummaryResponse | JSONResponse:
    result = await ScheduleLifecycleService.discard(db, schedule_id)
    match result:
        case ScheduleDiscarded(schedule=schedule):
            return ScheduleSummaryResponse.model_validate(schedule)
        case ScheduleNotFound():
            raise _schedule_not_found()
        case ScheduleIsDraft():
            return problem_response(
                ProblemDetail(
                    type="urn:floorsync:problem:schedule-is-draft",
                    title="Schedule is a draft",
                    status=status.HTTP_409_CONFLICT,
                    detail=(
                        "A draft was never the plan, so it cannot be discarded. Delete it with "
                        "DELETE /api/v1/schedules/{schedule_id} instead."
                    ),
                    instance=request.url.path,
                ),
            )
        case ScheduleSimulationStarted(
            simulation_id=simulation_id, simulation_status=simulation_status
        ):
            return problem_response(
                ProblemDetail(
                    type="urn:floorsync:problem:schedule-simulation-started",
                    title="Schedule has been simulated",
                    status=status.HTTP_409_CONFLICT,
                    detail=(
                        "The floor has started acting on this schedule, so it cannot be withdrawn."
                    ),
                    instance=request.url.path,
                ),
                extensions={
                    "simulation_id": str(simulation_id),
                    "simulation_status": simulation_status,
                },
            )
        case _:
            assert_never(result)


def _schedule_not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Schedule not found.")


@router.delete(
    "/{schedule_id}",
    # 204 on success and 409 when the schedule is no longer a draft, so the route returns a
    # Response itself rather than letting FastAPI infer one body shape for both.
    response_model=None,
    summary="Delete a draft schedule",
    responses={
        204: {"description": "The draft and everything recorded under it were removed"},
        409: {"description": "The schedule is confirmed or discarded, so it is history"},
    },
)
async def delete_schedule(
    schedule_id: UUID,
    request: Request,
    db: DbSession,
    _: Manager,
) -> Response | JSONResponse:
    """Throw away a draft nobody confirmed.

    A draft blocks removal of the jobs and operations it planned until it is gone, which is the
    usual reason to delete one: the manager generated it to look, then wants to change the job.
    Only drafts can be deleted; a confirmed schedule is what the floor was told to do and stays,
    together with any simulation of it (decision 0015).
    """

    async with db.begin():
        result = await ScheduleLifecycleService.delete_draft(db, schedule_id)

        match result:
            case ScheduleDeleted():
                return Response(status_code=status.HTTP_204_NO_CONTENT)
            case ScheduleNotFound():
                raise _schedule_not_found()
            case ScheduleNotDraft(status=schedule_status):
                return problem_response(
                    ProblemDetail(
                        type="urn:floorsync:problem:schedule-is-not-draft",
                        title="Schedule is no longer a draft",
                        status=status.HTTP_409_CONFLICT,
                        detail=(
                            f"This schedule is {schedule_status}, so it records what the floor "
                            "was told to do and cannot be deleted. Only drafts can be."
                        ),
                        instance=request.url.path,
                    ),
                    extensions={"schedule_status": schedule_status},
                )
            case _:
                assert_never(result)


def schedule_response(
    schedule: Schedule,
    entries: list[ScheduleEntry],
    dependencies: list[ScheduleDependency],
) -> ScheduleResponse:
    """Map persisted schedule rows to the public resource representation."""

    return ScheduleResponse(
        id=schedule.id,
        name=schedule.name,
        status=schedule.status,
        strategy=schedule.strategy,
        runtime_ms=schedule.runtime_ms,
        input_operation_count=schedule.input_operation_count,
        makespan=schedule.makespan,
        total_energy=schedule.total_energy,
        total_labour_cost=schedule.total_labour_cost,
        created_at=schedule.created_at,
        confirmed_by_user_id=schedule.confirmed_by_user_id,
        confirmed_at=schedule.confirmed_at,
        entries=[ScheduleEntryResponse.model_validate(entry) for entry in entries],
        dependencies=[
            ScheduleDependencyResponse.model_validate(dependency) for dependency in dependencies
        ],
    )


def schedule_generation_status(
    generation_id: UUID,
    task_state: str,
    task_result: object,
) -> ScheduleGenerationStatusResponse:
    """Translate Celery states and typed task outcomes into the public status resource."""

    if task_state == "STARTED":
        return ScheduleGenerationStatusResponse(id=generation_id, status="running")
    if task_state != "SUCCESS" or not isinstance(task_result, dict):
        status_name: Literal["failed", "pending"] = (
            "failed" if task_state == "FAILURE" else "pending"
        )
        if status_name == "failed":
            return ScheduleGenerationStatusResponse(
                id=generation_id,
                status="failed",
                detail=SCHEDULING_GENERATION_FAILED_DETAIL,
            )
        return ScheduleGenerationStatusResponse(id=generation_id, status="pending")

    outcome = task_result.get("outcome")
    if outcome == "stored":
        schedule_id = _uuid_or_none(task_result.get("schedule_id"))
        if schedule_id is not None:
            return ScheduleGenerationStatusResponse(
                id=generation_id,
                status="completed",
                schedule_id=schedule_id,
                schedule_url=f"/api/v1/schedules/{schedule_id}",
            )
    if outcome == "invalid":
        issues = _issues_or_none(task_result.get("issues"))
        if issues is not None:
            return ScheduleGenerationStatusResponse(
                id=generation_id,
                status="rejected",
                issues=issues,
            )
    if outcome == "unavailable":
        return ScheduleGenerationStatusResponse(
            id=generation_id,
            status="unavailable",
            detail=SCHEDULING_ENGINE_UNAVAILABLE_DETAIL,
        )
    return ScheduleGenerationStatusResponse(
        id=generation_id,
        status="failed",
        detail=SCHEDULING_GENERATION_FAILED_DETAIL,
    )


def queue_unavailable_problem(request: Request) -> JSONResponse:
    """Report a broker outage without exposing connection details."""

    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:scheduling-queue-unavailable",
            title="Scheduling queue is temporarily unavailable",
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The scheduling queue is not available. Try again later.",
            instance=request.url.path,
        )
    )


def _issue_response(issue: SchedulingIssue) -> SchedulingIssueResponse:
    return SchedulingIssueResponse(
        code=issue.code,
        message=issue.message,
        operation_id=issue.operation_id,
        machine_id=issue.machine_id,
        job_id=issue.job_id,
        schedule_id=issue.schedule_id,
    )


def _issues_or_none(value: object) -> list[SchedulingIssueResponse] | None:
    if not isinstance(value, list):
        return None
    try:
        return [SchedulingIssueResponse.model_validate(issue) for issue in value]
    except ValidationError:
        return None


def _uuid_or_none(value: object) -> UUID | None:
    if not isinstance(value, str):
        return None
    try:
        return UUID(value)
    except ValueError:
        return None
