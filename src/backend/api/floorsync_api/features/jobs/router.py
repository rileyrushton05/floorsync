from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse

from floorsync_api.dependencies.authentication import require_roles
from floorsync_api.dependencies.database import DbSession
from floorsync_api.features.jobs.schemas import (
    JobCreateRequest,
    JobDetailResponse,
    JobOperationResponse,
    JobResponse,
    JobUpdateRequest,
)
from floorsync_api.problems import ProblemDetail, problem_response
from floorsync_api.schemas import CursorPage
from floorsync_common.database.models.user import User
from floorsync_common.jobs.results import (
    JobDeleted,
    JobFound,
    JobIsScheduled,
    JobNotFound,
    JobUpdated,
)
from floorsync_common.jobs.service import UNSET, JobService

router = APIRouter(prefix="/jobs", tags=["jobs"])
Manager = Annotated[User, Depends(require_roles("manager"))]


@router.post(
    "",
    response_model=JobResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a job",
)
async def create_job(
    command: JobCreateRequest,
    response: Response,
    db: DbSession,
    _: Manager,
) -> JobResponse:
    """Add a job to the backlog. Its operations are added separately."""

    async with db.begin():
        job = await JobService.create_job(db, name=command.name)
        response.headers["Location"] = f"/api/v1/jobs/{job.id}"
        return JobResponse.model_validate(job)


@router.get(
    "",
    response_model=CursorPage[JobResponse],
    summary="List jobs",
)
async def list_jobs(
    db: DbSession,
    _: Manager,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
) -> CursorPage[JobResponse]:
    """List jobs by name, a page at a time."""

    async with db.begin():
        page = await JobService.list_jobs(db, limit=limit, cursor=cursor)

    return CursorPage[JobResponse](
        items=[JobResponse.model_validate(job) for job in page.jobs],
        next_cursor=page.next_cursor,
    )


@router.get(
    "/{job_id}",
    response_model=JobDetailResponse,
    summary="Get a job and its operations",
)
async def get_job(job_id: UUID, db: DbSession, _: Manager) -> JobDetailResponse:
    """Read one job together with the operations it contains."""

    async with db.begin():
        result = await JobService.get_job(db, job_id)

        match result:
            case JobFound(job=job, operations=operations):
                return JobDetailResponse(
                    **JobResponse.model_validate(job).model_dump(),
                    operations=[
                        JobOperationResponse.model_validate(operation) for operation in operations
                    ],
                )
            case JobNotFound():
                raise _job_not_found()
            case _:
                assert_never(result)


@router.patch(
    "/{job_id}",
    response_model=JobResponse,
    summary="Update a job",
)
async def update_job(
    job_id: UUID,
    command: JobUpdateRequest,
    db: DbSession,
    _: Manager,
) -> JobResponse:
    """Apply a partial update, so a later schedule is generated from the corrected job."""

    changes = command.model_dump(exclude_unset=True)

    async with db.begin():
        result = await JobService.update_job(db, job_id, name=changes.get("name", UNSET))

        match result:
            case JobUpdated(job=job):
                return JobResponse.model_validate(job)
            case JobNotFound():
                raise _job_not_found()
            case _:
                assert_never(result)


@router.delete(
    "/{job_id}",
    # The route answers 204 on success and 409 when the job is scheduled, so it returns a Response
    # itself rather than letting FastAPI infer one body shape for both.
    response_model=None,
    summary="Remove a job",
    responses={
        204: {"description": "The job and its operations were removed"},
        409: {"description": "The job's work already appears in a schedule"},
    },
)
async def delete_job(
    job_id: UUID,
    request: Request,
    db: DbSession,
    _: Manager,
) -> Response | JSONResponse:
    """Remove a job entered by mistake, together with its operations.

    A job whose operations already appear in a schedule cannot be removed: the schedule records what
    was planned, and deleting the job would destroy that history. See the deletion policy in
    docs/database-schema.md.
    """

    async with db.begin():
        result = await JobService.delete_job(db, job_id)

        match result:
            case JobDeleted():
                return Response(status_code=status.HTTP_204_NO_CONTENT)
            case JobNotFound():
                raise _job_not_found()
            case JobIsScheduled():
                return problem_response(
                    ProblemDetail(
                        type="urn:floorsync:problem:job-is-scheduled",
                        title="Job appears in a schedule",
                        status=status.HTTP_409_CONFLICT,
                        detail=(
                            "This job's operations appear in a generated schedule, so removing it "
                            "would destroy that schedule's record of what was planned."
                        ),
                        instance=request.url.path,
                    )
                )
            case _:
                assert_never(result)


def _job_not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
