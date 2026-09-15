from typing import Annotated, Literal
from uuid import UUID

from celery.exceptions import OperationalError
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
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
    SchedulingIssueResponse,
)
from floorsync_api.problems import ProblemDetail, problem_response
from floorsync_common.database.models.schedule import Schedule
from floorsync_common.database.models.schedule_dependency import ScheduleDependency
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.user import User
from floorsync_common.scheduling.task_names import SCHEDULE_GENERATION_TASK
from floorsync_common.task_queue import create_task_queue

router = APIRouter(prefix="/schedules", tags=["schedules"])
Manager = Annotated[User, Depends(require_roles("manager"))]
task_queue = create_task_queue()

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

    try:
        task = task_queue.send_task(
            SCHEDULE_GENERATION_TASK,
            # The selection travels as strings because a Celery argument has to survive JSON, and
            # is sent unvalidated: checking it needs the dependency graph, and this endpoint reads
            # no database at all. The worker refuses a bad selection and the status resource
            # reports it, the same way every other unschedulable input is reported.
            args=(
                command.starts_at.isoformat(),
                None if command.job_ids is None else [str(job_id) for job_id in command.job_ids],
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


def schedule_response(
    schedule: Schedule,
    entries: list[ScheduleEntry],
    dependencies: list[ScheduleDependency],
) -> ScheduleResponse:
    """Map persisted schedule rows to the public resource representation."""

    return ScheduleResponse(
        id=schedule.id,
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
