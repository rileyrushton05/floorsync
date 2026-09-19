from collections.abc import Sequence
from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse

from floorsync_api.dependencies.authentication import require_roles
from floorsync_api.dependencies.database import DbSession
from floorsync_api.features.operations.schemas import (
    DependencyResponse,
    JobDependenciesReplaceRequest,
    JobDependenciesResponse,
    OperationCompatibilityResponse,
    OperationCreateRequest,
    OperationDetailResponse,
    OperationResponse,
    OperationUpdateRequest,
)
from floorsync_api.problems import (
    ProblemDetail,
    job_has_left_backlog_problem,
    problem_response,
    schedule_references_hint,
    schedule_references_members,
)
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.user import User
from floorsync_common.jobs.results import JobHasLeftBacklog, JobNotFound
from floorsync_common.operations.results import (
    DependencyCycle,
    JobDependenciesListed,
    JobDependenciesReplaced,
    OperationCreated,
    OperationDeleted,
    OperationFound,
    OperationIsScheduled,
    OperationNotFound,
    OperationNotInJob,
    OperationUpdated,
)
from floorsync_common.operations.service import (
    DependencyEdge,
    DependencyService,
    OperationService,
)
from floorsync_common.partial import UNSET

router = APIRouter(prefix="/operations", tags=["operations"])
job_operations_router = APIRouter(prefix="/jobs", tags=["operations"])
Manager = Annotated[User, Depends(require_roles("manager"))]


@job_operations_router.post(
    "/{job_id}/operations",
    response_model=OperationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add an operation to a job",
    responses={409: {"description": "The job has left the backlog and is read-only"}},
)
async def create_operation(
    job_id: UUID,
    command: OperationCreateRequest,
    request: Request,
    response: Response,
    db: DbSession,
    _: Manager,
) -> OperationResponse | JSONResponse:
    """Add a step to a job. Its durations and its ordering are recorded separately.

    Refused unless the job is open (decisions 0018, 0019).
    """

    async with db.begin():
        result = await OperationService.create_operation(db, job_id, name=command.name)

        match result:
            case OperationCreated(operation=operation):
                response.headers["Location"] = f"/api/v1/operations/{operation.id}"
                return OperationResponse.model_validate(operation)
            case JobNotFound():
                raise _job_not_found()
            case JobHasLeftBacklog(backlog=backlog, archived_at=archived_at):
                return job_has_left_backlog_problem(request, job_id, backlog, archived_at)
            case _:
                assert_never(result)


@job_operations_router.get(
    "/{job_id}/dependencies",
    response_model=JobDependenciesResponse,
    summary="Get the order a job's operations run in",
)
async def list_job_dependencies(
    job_id: UUID,
    db: DbSession,
    _: Manager,
) -> JobDependenciesResponse:
    """Read a job's ordering: every edge its own operations wait on."""

    async with db.begin():
        result = await DependencyService.list_job_dependencies(db, job_id)

        match result:
            case JobDependenciesListed(dependencies=dependencies):
                return _dependencies_response(dependencies)
            case JobNotFound():
                raise _job_not_found()
            case _:
                assert_never(result)


@job_operations_router.put(
    "/{job_id}/dependencies",
    response_model=JobDependenciesResponse,
    summary="Set the order a job's operations run in",
    responses={
        409: {"description": "The job has left the backlog and is read-only"},
        422: {
            "description": (
                "An edge names an unknown operation, orders an operation belonging to another job, "
                "or the ordering would form a cycle"
            )
        },
    },
)
async def replace_job_dependencies(
    job_id: UUID,
    command: JobDependenciesReplaceRequest,
    request: Request,
    db: DbSession,
    _: Manager,
) -> JobDependenciesResponse | JSONResponse:
    """Replace a job's ordering with the one supplied, atomically.

    The whole ordering is sent rather than one edge at a time because reordering is a single change:
    applied edge by edge it would pass through graphs that may themselves be cyclic, and a failure
    part-way would leave an order nobody asked for. Sending the whole graph also means the cycle
    check is one question about one graph.

    Idempotent, as `PUT` requires: re-sending the same ordering restates it.
    """

    async with db.begin():
        result = await DependencyService.replace_job_dependencies(
            db,
            job_id,
            edges=[
                DependencyEdge(
                    before_operation_id=edge.before_operation_id,
                    after_operation_id=edge.after_operation_id,
                )
                for edge in command.edges
            ],
        )

        match result:
            case JobDependenciesReplaced(dependencies=dependencies):
                return _dependencies_response(dependencies)
            case JobNotFound():
                raise _job_not_found()
            case JobHasLeftBacklog(backlog=backlog, archived_at=archived_at):
                return job_has_left_backlog_problem(request, job_id, backlog, archived_at)
            case OperationNotFound(operation_id=operation_id):
                return _operation_reference_invalid(request, operation_id)
            case OperationNotInJob(operation_id=operation_id, job_id=owning_job_id):
                return _operation_not_in_job(request, operation_id, owning_job_id)
            case DependencyCycle(operation_ids=operation_ids):
                return _dependency_cycle(request, operation_ids)
            case _:
                assert_never(result)


@router.get(
    "/{operation_id}",
    response_model=OperationDetailResponse,
    summary="Get an operation, its machine options and its place in the order",
)
async def get_operation(operation_id: UUID, db: DbSession, _: Manager) -> OperationDetailResponse:
    """Read one operation with everything needed to edit it.

    The capability rows are also reachable machine-first, but answering "what can run this step, and
    how long does each take" from there would mean reading every machine on the floor.
    """

    async with db.begin():
        result = await OperationService.get_operation(db, operation_id)

        match result:
            case OperationFound(
                operation=operation,
                compatibilities=compatibilities,
                predecessors=predecessors,
                successors=successors,
            ):
                return OperationDetailResponse(
                    **OperationResponse.model_validate(operation).model_dump(),
                    compatibilities=[
                        OperationCompatibilityResponse.model_validate(compatibility)
                        for compatibility in compatibilities
                    ],
                    predecessors=[edge.before_operation_id for edge in predecessors],
                    successors=[edge.after_operation_id for edge in successors],
                )
            case OperationNotFound():
                raise _operation_not_found()
            case _:
                assert_never(result)


@router.patch(
    "/{operation_id}",
    response_model=OperationResponse,
    summary="Update an operation",
    responses={409: {"description": "The operation's job has left the backlog and is read-only"}},
)
async def update_operation(
    operation_id: UUID,
    command: OperationUpdateRequest,
    request: Request,
    db: DbSession,
    _: Manager,
) -> OperationResponse | JSONResponse:
    """Apply a partial update, so a later schedule is generated from the corrected step.

    Refused unless the operation's job is open (decisions 0018, 0019).
    """

    changes = command.model_dump(exclude_unset=True)

    async with db.begin():
        result = await OperationService.update_operation(
            db,
            operation_id,
            name=changes.get("name", UNSET),
        )

        match result:
            case OperationUpdated(operation=operation):
                return OperationResponse.model_validate(operation)
            case OperationNotFound():
                raise _operation_not_found()
            case JobHasLeftBacklog(job_id=job_id, backlog=backlog, archived_at=archived_at):
                return job_has_left_backlog_problem(request, job_id, backlog, archived_at)
            case _:
                assert_never(result)


@router.delete(
    "/{operation_id}",
    # The route answers 204 on success and 409 when the operation is scheduled, so it returns a
    # Response itself rather than letting FastAPI infer one body shape for both.
    response_model=None,
    summary="Remove an operation",
    responses={
        204: {"description": "The operation, its capabilities and its ordering were removed"},
        409: {
            "description": (
                "The operation already appears in a schedule, or its job has left the backlog "
                "and is read-only"
            )
        },
    },
)
async def delete_operation(
    operation_id: UUID,
    request: Request,
    db: DbSession,
    _: Manager,
) -> Response | JSONResponse:
    """Remove a step entered by mistake, together with its capabilities and its ordering edges.

    An operation that already appears in a schedule cannot be removed: the schedule records what was
    planned, and deleting the step would destroy that history. See the deletion policy in
    docs/database-schema.md.
    """

    async with db.begin():
        result = await OperationService.delete_operation(db, operation_id)

        match result:
            case OperationDeleted():
                return Response(status_code=status.HTTP_204_NO_CONTENT)
            case OperationNotFound():
                raise _operation_not_found()
            case JobHasLeftBacklog(job_id=job_id, backlog=backlog, archived_at=archived_at):
                return job_has_left_backlog_problem(request, job_id, backlog, archived_at)
            case OperationIsScheduled(references=references):
                return problem_response(
                    ProblemDetail(
                        type="urn:floorsync:problem:operation-is-scheduled",
                        title="Operation appears in a schedule",
                        status=status.HTTP_409_CONFLICT,
                        detail=(
                            "This operation appears in a generated schedule, so removing it would "
                            "destroy that schedule's record of what was planned. "
                            + schedule_references_hint(references)
                        ),
                        instance=request.url.path,
                    ),
                    extensions=schedule_references_members(references),
                )
            case _:
                assert_never(result)


def _dependencies_response(dependencies: Sequence[Dependency]) -> JobDependenciesResponse:
    return JobDependenciesResponse(
        edges=[DependencyResponse.model_validate(dependency) for dependency in dependencies]
    )


def _job_not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")


def _operation_not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operation not found.")


def _operation_reference_invalid(request: Request, operation_id: UUID) -> JSONResponse:
    """An edge naming an operation that does not exist is unprocessable, not a missing page."""

    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:operation-not-found",
            title="Referenced operation does not exist",
            status=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"No operation exists with id {operation_id}.",
            instance=request.url.path,
        )
    )


def _operation_not_in_job(request: Request, operation_id: UUID, job_id: UUID) -> JSONResponse:
    """A job owns what its own steps wait on, so it cannot order another job's step.

    Only the `after` side is restricted: naming an operation from another job as a predecessor is
    deliberately allowed.
    """

    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:operation-not-in-job",
            title="Operation belongs to another job",
            status=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Operation {operation_id} is not part of job {job_id}, so this job cannot set "
                "what it waits on."
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
                "This ordering would make operations wait on each other in a loop, so none of them "
                "could ever start."
            ),
            instance=request.url.path,
        ),
        extensions={"operation_ids": [str(operation_id) for operation_id in operation_ids]},
    )
