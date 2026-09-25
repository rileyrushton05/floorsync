from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse

from floorsync_api.dependencies.authentication import require_roles
from floorsync_api.dependencies.database import DbSession
from floorsync_api.features.jobs.schemas import (
    JobCreateRequest,
    JobDependencyEdgeResponse,
    JobDependencyGraphResponse,
    JobDetailResponse,
    JobResponse,
    JobUpdateRequest,
)
from floorsync_api.problems import (
    ProblemDetail,
    job_has_left_backlog_problem,
    problem_response,
    schedule_references_hint,
    schedule_references_members,
)
from floorsync_api.schemas import CursorPage
from floorsync_common.database.models.user import User
from floorsync_common.jobs.backlog import OPEN, BacklogService
from floorsync_common.jobs.results import (
    JobDeleted,
    JobFound,
    JobHasLeftBacklog,
    JobIsScheduled,
    JobNotFound,
    JobUpdated,
)
from floorsync_common.jobs.service import JobService
from floorsync_common.partial import UNSET

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
        # A job that did not exist a moment ago is in no schedule; no need to ask.
        return JobResponse.from_job(job, OPEN)


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
    include_archived: bool = False,
) -> CursorPage[JobResponse]:
    """List the backlog by name, a page at a time.

    Archived jobs are left out unless `include_archived` is set: they have finished or been
    cancelled and are no longer offered for scheduling, but they still exist because the schedules
    that planned them do.
    """

    async with db.begin():
        page = await JobService.list_jobs(
            db, limit=limit, cursor=cursor, include_archived=include_archived
        )
        backlog = await BacklogService.load(db, page.jobs)

    return CursorPage[JobResponse](
        items=[JobResponse.from_job(job, backlog[job.id]) for job in page.jobs],
        next_cursor=page.next_cursor,
    )


# Declared before `/{job_id}`: FastAPI matches routes in declaration order, and the other way round
# this path is read as a job id and refused as a malformed UUID before ever reaching here.
@router.get(
    "/dependency-graph",
    response_model=JobDependencyGraphResponse,
    summary="Get which jobs wait on which",
)
async def get_job_dependency_graph(db: DbSession, _: Manager) -> JobDependencyGraphResponse:
    """Read every cross-job precedence edge, so a caller can tell what selecting a job implies.

    Scoped schedule generation refuses a selection that leaves out a job a selected job waits on
    (#231). This is how a caller works that out before sending one: take the jobs the manager
    ticked, follow these edges backwards, and tick whatever they land on. Following them forwards
    would pull in jobs that merely wait on the selection, which do not have to be scheduled with it.

    The whole graph, unpaginated, because it is one row per cross-job edge and a job's prerequisites
    are not confined to any one page of `GET /api/v1/jobs`.
    """

    async with db.begin():
        graph = await JobService.list_dependency_graph(db)

    return JobDependencyGraphResponse(
        edges=[
            JobDependencyEdgeResponse(before_job_id=before, after_job_id=after)
            for before, after in graph.edges
        ]
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
                backlog = await BacklogService.load(db, [job])
                return JobDetailResponse.from_job_and_operations(job, backlog[job.id], operations)
            case JobNotFound():
                raise _job_not_found()
            case _:
                assert_never(result)


@router.patch(
    "/{job_id}",
    response_model=JobResponse,
    summary="Update a job",
    responses={
        409: {"description": "The job has left the backlog and is read-only"},
    },
)
async def update_job(
    job_id: UUID,
    command: JobUpdateRequest,
    request: Request,
    db: DbSession,
    _: Manager,
) -> JobResponse | JSONResponse:
    """Apply a partial update, so a later schedule is generated from the corrected job.

    `archived: true` retires a job by hand: an open one that was cancelled, or a planned one the
    manager is pulling from its plan. It touches no schedule and does not make the job deletable.
    Only an open job can be renamed (decisions 0018, 0019); a planned job comes back when its
    schedule is discarded, and archiving is one way.
    """

    changes = command.model_dump(exclude_unset=True)

    async with db.begin():
        result = await JobService.update_job(
            db,
            job_id,
            name=changes.get("name", UNSET),
            archived=changes.get("archived", UNSET),
        )

        match result:
            case JobUpdated(job=job):
                backlog = await BacklogService.load(db, [job])
                return JobResponse.from_job(job, backlog[job.id])
            case JobNotFound():
                raise _job_not_found()
            case JobHasLeftBacklog(job_id=job_id, backlog=backlog, archived_at=archived_at):
                return job_has_left_backlog_problem(request, job_id, backlog, archived_at)
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
        409: {
            "description": (
                "The job's work appears in a schedule; the body names the draft and confirmed "
                "schedules involved"
            )
        },
    },
)
async def delete_job(
    job_id: UUID,
    request: Request,
    db: DbSession,
    _: Manager,
) -> Response | JSONResponse:
    """Remove a job entered by mistake, together with its operations.

    A job whose operations appear in a schedule cannot be removed: the schedule records what was
    planned, and deleting the job would destroy that history. The 409 names the schedules in the
    way. Drafts among them can be deleted first; a confirmed schedule cannot, and the job is
    archived instead (`PATCH` with `archived: true`). See decision 0015.
    """

    async with db.begin():
        result = await JobService.delete_job(db, job_id)

        match result:
            case JobDeleted():
                return Response(status_code=status.HTTP_204_NO_CONTENT)
            case JobNotFound():
                raise _job_not_found()
            case JobIsScheduled(references=references):
                return problem_response(
                    ProblemDetail(
                        type="urn:floorsync:problem:job-is-scheduled",
                        title="Job appears in a schedule",
                        status=status.HTTP_409_CONFLICT,
                        detail=(
                            "This job's operations appear in a generated schedule, so removing it "
                            "would destroy that schedule's record of what was planned. "
                            + schedule_references_hint(references)
                        ),
                        instance=request.url.path,
                    ),
                    extensions=schedule_references_members(references),
                )
            case _:
                assert_never(result)


def _job_not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
