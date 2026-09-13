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
from floorsync_api.problems import ProblemDetail, problem_response
from floorsync_api.schemas import CursorPage
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.user import User
from floorsync_common.jobs.definition_results import (
    DefinitionCreated,
    DefinitionFound,
    DefinitionReplaced,
    InactiveMachine,
    JobDefinitionIsScheduled,
    JobDefinitionRead,
    OperationDoesNotBelongToJob,
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
from floorsync_common.jobs.results import JobNotFound

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
                return _definition_response(definition)
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
) -> CursorPage[JobDefinitionResponse]:
    """List every job with its operations and routes, a page at a time.

    Lists every operation and route in this page in bulk, so the frontend has no N+1 detail fetch.
    """

    async with db.begin():
        page = await JobDefinitionService.list_definitions(db, limit=limit, cursor=cursor)

    return CursorPage[JobDefinitionResponse](
        items=[_definition_response(definition) for definition in page.definitions],
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
                return _definition_response(definition)
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
        409: {"description": "An operation in this job already appears in a schedule"},
        422: {
            "description": (
                "A route names an unknown or inactive machine, or an operation id does not "
                "belong to this job"
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

    Refused with a conflict when any of this job's operations already appears in a generated
    schedule, so a definition save can never rewrite a schedule's record of what was planned.
    """

    async with db.begin():
        result = await JobDefinitionService.replace_definition(
            db, job_id, _replace_command(command)
        )

        match result:
            case DefinitionReplaced(definition=definition):
                return _definition_response(definition)
            case JobNotFound():
                return _job_not_found(request, job_id)
            case JobDefinitionIsScheduled():
                return _job_definition_is_scheduled(request, job_id)
            case OperationDoesNotBelongToJob(operation_id=operation_id, job_id=owning_job_id):
                return _operation_does_not_belong_to_job(request, operation_id, owning_job_id)
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


def _definition_response(definition: JobDefinitionRead) -> JobDefinitionResponse:
    return JobDefinitionResponse(
        id=definition.job.id,
        name=definition.job.name,
        priority=definition.job.priority,
        created_at=definition.job.created_at,
        updated_at=definition.job.updated_at,
        operations=[_operation_response(item) for item in definition.operations],
    )


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


def _job_definition_is_scheduled(request: Request, job_id: UUID) -> JSONResponse:
    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:job_definition_is_scheduled",
            title="Job definition already appears in a schedule",
            status=status.HTTP_409_CONFLICT,
            detail=(
                f"An operation in job {job_id} already appears in a generated schedule, so "
                "saving this definition would rewrite inputs that schedule already recorded."
            ),
            instance=request.url.path,
        )
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
