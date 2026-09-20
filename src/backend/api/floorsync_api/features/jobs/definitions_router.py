"""Routes for the job-definition builder: create, read and atomically replace a whole job.

Deliberately no route per operation or per edge -- the builder edits a whole definition at once, so
a piecemeal write could leave an invalid intermediate state, such as an operation with no route.
`GET/PATCH /jobs` and the operation/dependency routes remain lightweight compatibility routes, not
the builder write interface.
"""

from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import JSONResponse

from floorsync_api.dependencies.authentication import require_roles
from floorsync_api.dependencies.database import DbSession
from floorsync_api.features.jobs.definitions_schemas import (
    BuilderOperationResponse,
    BuilderRouteInput,
    BuilderRouteResponse,
    JobDefinitionCreateRequest,
    JobDefinitionReplaceRequest,
    JobDefinitionResponse,
)
from floorsync_api.problems import (
    ProblemDetail,
    job_has_left_backlog_problem,
    problem_response,
    schedule_references_hint,
    schedule_references_members,
)
from floorsync_api.schemas import CursorPage
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.user import User
from floorsync_common.jobs.backlog import OPEN, BacklogService, JobBacklog
from floorsync_common.jobs.definition_results import (
    DefinitionCreated,
    DefinitionFound,
    DefinitionReplaced,
    InactiveMachine,
    JobDefinitionIsScheduled,
    JobDefinitionRead,
    OperationDoesNotBelongToJob,
    OperationHasExternalDependents,
    OperationWithRoutes,
    UnknownMachine,
)
from floorsync_common.jobs.definitions import (
    BuilderOperationCreate,
    BuilderOperationReplace,
    BuilderRoute,
    JobDefinitionCreateCommand,
    JobDefinitionReplaceCommand,
    JobDefinitionService,
)
from floorsync_common.jobs.results import JobHasLeftBacklog, JobNotFound
from floorsync_common.operations.results import DependencyCycle
from floorsync_common.scheduling.references import ScheduleReferences

job_definitions_router = APIRouter(prefix="/job-definitions", tags=["jobs"])
job_definition_router = APIRouter(prefix="/jobs", tags=["jobs"])
Manager = Annotated[User, Depends(require_roles("manager"))]


@job_definitions_router.post(
    "",
    response_model=JobDefinitionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a complete job definition",
    responses={422: {"description": "A route names an unknown or inactive machine"}},
)
async def create_definition(
    command: JobDefinitionCreateRequest,
    request: Request,
    response: Response,
    db: DbSession,
    _: Manager,
) -> JobDefinitionResponse | JSONResponse:
    """Create one job, its operations and their machine routes in a single transaction.

    A failed validation writes nothing: no job, operation or compatibility row exists unless every
    route names an active machine.
    """

    async with db.begin():
        result = await JobDefinitionService.create_definition(db, _create_command(command))

        match result:
            case DefinitionCreated(definition=definition):
                response.headers["Location"] = f"/api/v1/jobs/{definition.job.id}/definition"
                # A job that did not exist a moment ago is in no schedule; no need to ask.
                return _definition_response(definition, OPEN)
            case UnknownMachine(machine_id=machine_id):
                return _unknown_machine(request, machine_id)
            case InactiveMachine(machine_id=machine_id):
                return _inactive_machine(request, machine_id)
            case _:
                assert_never(result)


@job_definitions_router.get(
    "",
    response_model=CursorPage[JobDefinitionResponse],
    summary="Page through complete job definitions",
)
async def list_definitions(
    db: DbSession,
    _: Manager,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
    include_archived: bool = False,
) -> CursorPage[JobDefinitionResponse]:
    """List the backlog's jobs with their operations and routes, a page at a time.

    Lists every operation and route in this page in bulk, so the frontend has no N+1 detail fetch.
    Archived jobs are left out unless `include_archived` is set, matching `GET /api/v1/jobs`.
    """

    async with db.begin():
        page = await JobDefinitionService.list_definitions(
            db, limit=limit, cursor=cursor, include_archived=include_archived
        )
        backlog = await BacklogService.load(db, [definition.job for definition in page.definitions])

    return CursorPage[JobDefinitionResponse](
        items=[
            _definition_response(definition, backlog[definition.job.id])
            for definition in page.definitions
        ],
        next_cursor=page.next_cursor,
    )


@job_definition_router.get(
    "/{job_id}/definition",
    response_model=JobDefinitionResponse,
    summary="Read one job definition for editing",
)
async def get_definition(
    job_id: UUID, request: Request, db: DbSession, _: Manager
) -> JobDefinitionResponse | JSONResponse:
    """Read a job's complete definition: its priority, its operations and their routes, in order."""

    async with db.begin():
        result = await JobDefinitionService.get_definition(db, job_id)

        match result:
            case DefinitionFound(definition=definition):
                return await _definition_with_backlog(db, definition)
            case JobNotFound():
                return _job_not_found(request, job_id)
            case _:
                assert_never(result)


@job_definition_router.put(
    "/{job_id}/definition",
    response_model=JobDefinitionResponse,
    summary="Atomically replace one editable definition",
    responses={
        404: {"description": "The job does not exist"},
        409: {
            "description": (
                "The job has left the backlog and is read-only, or the save would remove an "
                "operation that appears in a schedule; the body names the schedules involved"
            )
        },
        422: {
            "description": (
                "A route names an unknown or inactive machine, an operation id does not belong "
                "to this job, removing an operation would delete another job's edge to it, or "
                "the new ordering would form a cycle"
            )
        },
    },
)
async def replace_definition(
    job_id: UUID,
    command: JobDefinitionReplaceRequest,
    request: Request,
    db: DbSession,
    _: Manager,
) -> JobDefinitionResponse | JSONResponse:
    """Replace a job's name, priority, operations and routes wholesale, atomically.

    Omit an existing operation's id to delete it; omit id entirely for a new operation. The array
    index becomes each operation's 1-based position. Only this job's own `builder_sequence`
    ordering edges are rebuilt; externally owned edges are never touched.

    Refused with a conflict when the job is not open (planned, done or archived: duplicate it
    instead, decisions 0018 and 0019) or when the save would remove an operation a draft
    schedule already recorded; every other edit is covered by the draft's own snapshot. The
    scheduled conflict names the schedules in the way.
    """

    async with db.begin():
        result = await JobDefinitionService.replace_definition(
            db, job_id, _replace_command(command)
        )

        match result:
            case DefinitionReplaced(definition=definition):
                return await _definition_with_backlog(db, definition)
            case JobNotFound():
                return _job_not_found(request, job_id)
            case JobHasLeftBacklog(backlog=backlog, archived_at=archived_at):
                return job_has_left_backlog_problem(request, job_id, backlog, archived_at)
            case JobDefinitionIsScheduled(references=references):
                return _job_definition_is_scheduled(request, job_id, references)
            case OperationDoesNotBelongToJob(operation_id=operation_id, job_id=owning_job_id):
                return _operation_does_not_belong_to_job(request, operation_id, owning_job_id)
            case OperationHasExternalDependents(operation_id=operation_id, job_id=owning_job_id):
                return _operation_has_external_dependents(request, operation_id, owning_job_id)
            case DependencyCycle(operation_ids=operation_ids):
                return _dependency_cycle(request, operation_ids)
            case UnknownMachine(machine_id=machine_id):
                return _unknown_machine(request, machine_id)
            case InactiveMachine(machine_id=machine_id):
                return _inactive_machine(request, machine_id)
            case _:
                assert_never(result)


# -- command mapping: HTTP schema -> domain command, per docs/backend-conventions.md ---------


def _routes(routes: list[BuilderRouteInput]) -> tuple[BuilderRoute, ...]:
    return tuple(
        BuilderRoute(
            machine_id=route.machine_id,
            duration_minutes=route.duration_minutes,
            energy=route.energy,
        )
        for route in routes
    )


def _create_command(command: JobDefinitionCreateRequest) -> JobDefinitionCreateCommand:
    return JobDefinitionCreateCommand(
        name=command.name,
        priority=command.priority,
        operations=tuple(
            BuilderOperationCreate(name=operation.name, routes=_routes(operation.routes))
            for operation in command.operations
        ),
    )


def _replace_command(command: JobDefinitionReplaceRequest) -> JobDefinitionReplaceCommand:
    return JobDefinitionReplaceCommand(
        name=command.name,
        priority=command.priority,
        operations=tuple(
            BuilderOperationReplace(
                id=operation.id, name=operation.name, routes=_routes(operation.routes)
            )
            for operation in command.operations
        ),
    )


# -- response assembly: domain read model -> HTTP schema ---------------------------------------


def _route_response(compatibility: Compatibility) -> BuilderRouteResponse:
    return BuilderRouteResponse(
        machine_id=compatibility.machine_id,
        duration_minutes=compatibility.duration,
        energy=compatibility.energy,
    )


def _operation_response(item: OperationWithRoutes) -> BuilderOperationResponse:
    return BuilderOperationResponse(
        id=item.operation.id,
        position=item.operation.position,
        name=item.operation.name,
        routes=[_route_response(route) for route in item.routes],
    )


def _definition_response(
    definition: JobDefinitionRead, backlog: JobBacklog
) -> JobDefinitionResponse:
    return JobDefinitionResponse(
        id=definition.job.id,
        name=definition.job.name,
        priority=definition.job.priority,
        archived_at=definition.job.archived_at,
        backlog_status=backlog.status,
        planned_by_schedule_ids=list(backlog.schedule_ids),
        created_at=definition.job.created_at,
        updated_at=definition.job.updated_at,
        operations=[_operation_response(item) for item in definition.operations],
    )


async def _definition_with_backlog(
    db: DbSession, definition: JobDefinitionRead
) -> JobDefinitionResponse:
    backlog = await BacklogService.load(db, [definition.job])
    return _definition_response(definition, backlog[definition.job.id])


# -- problem responses ---------------------------------------------------------------------------


def _job_not_found(request: Request, job_id: UUID) -> JSONResponse:
    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:job-not-found",
            title="Job not found",
            status=status.HTTP_404_NOT_FOUND,
            detail=f"No job exists with id {job_id}.",
            instance=request.url.path,
        )
    )


def _job_definition_is_scheduled(
    request: Request, job_id: UUID, references: ScheduleReferences
) -> JSONResponse:
    """Only a removal is refused: every other edit is covered by the schedule's own snapshot."""

    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:job_definition_is_scheduled",
            title="Operation appears in a generated schedule",
            status=status.HTTP_409_CONFLICT,
            detail=(
                f"This save removes an operation from job {job_id} that a generated schedule "
                "already recorded, which would leave that schedule referring to a step that no "
                "longer exists. Keep the operation, or clear the schedules in the way. "
                + schedule_references_hint(references)
            ),
            instance=request.url.path,
        ),
        extensions=schedule_references_members(references),
    )


def _unknown_machine(request: Request, machine_id: UUID) -> JSONResponse:
    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:unknown_machine",
            title="Route references no machine",
            status=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"No machine exists with id {machine_id}.",
            instance=request.url.path,
        )
    )


def _inactive_machine(request: Request, machine_id: UUID) -> JSONResponse:
    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:inactive_machine",
            title="Route uses an inactive machine",
            status=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Machine {machine_id} is retired or inactive and cannot be routed to.",
            instance=request.url.path,
        )
    )


def _operation_does_not_belong_to_job(
    request: Request, operation_id: UUID, job_id: UUID
) -> JSONResponse:
    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:operation_does_not_belong_to_job",
            title="Operation does not belong to this job",
            status=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Operation {operation_id} does not belong to job {job_id}, so it cannot be "
                "retained by this replacement."
            ),
            instance=request.url.path,
        )
    )


def _operation_has_external_dependents(
    request: Request, operation_id: UUID, other_job_id: UUID
) -> JSONResponse:
    """Omitting an operation another job depends on would silently delete that job's own edge."""

    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:operation_has_external_dependents",
            title="Operation is depended on by another job",
            status=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Removing operation {operation_id} would delete an ordering edge job "
                f"{other_job_id} depends on. Remove that edge first, through the ordering API."
            ),
            instance=request.url.path,
        )
    )


def _dependency_cycle(request: Request, operation_ids: tuple[UUID, ...]) -> JSONResponse:
    """A cyclic ordering describes work that could never start, so it is refused before storing."""

    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:dependency-cycle",
            title="Ordering forms a cycle",
            status=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "This ordering would make operations wait on each other in a loop, so none of "
                "them could ever start."
            ),
            instance=request.url.path,
        ),
        extensions={"operation_ids": [str(operation_id) for operation_id in operation_ids]},
    )
