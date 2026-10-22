"""Import machines, jobs and operations from an uploaded file (#297, decision 0020).

One route, with a dry run. The preview and the real import run the same code against the same
transaction; the dry run rolls back at the end, so what it reports is what an import would do.
"""

from collections.abc import Sequence
from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends, File, Query, Request, Response, UploadFile, status
from fastapi.responses import JSONResponse

from floorsync_api.dependencies.authentication import require_roles
from floorsync_api.dependencies.database import DbSession
from floorsync_api.features.imports.schemas import (
    ImportIssueResponse,
    ImportJobPreviewResponse,
    ImportOperationPreviewResponse,
    ImportReportResponse,
    ImportRoutePreviewResponse,
)
from floorsync_api.problems import ProblemDetail, problem_response
from floorsync_common.database.models.user import User
from floorsync_common.imports.plan import ImportIssue, ImportPlan, PlannedJob
from floorsync_common.imports.results import (
    FileUnreadable,
    ImportApplied,
    ImportRejected,
    ImportSummary,
    PlanRead,
)
from floorsync_common.imports.service import ImportService

router = APIRouter(prefix="/imports", tags=["imports"])
Manager = Annotated[User, Depends(require_roles("manager"))]


@router.post(
    "",
    response_model=ImportReportResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Import machines, jobs and operations from a file",
    responses={
        200: {
            "description": "Dry run: what the import would add, with any problems",
            "model": ImportReportResponse,
        },
        413: {"description": "The file is larger than the request size limit"},
        422: {"description": "The file has problems, so nothing was imported"},
    },
)
async def import_file(
    file: Annotated[
        UploadFile,
        File(
            description=(
                "A FloorSync JSON file, or a ScheduleOpt job-shop or flexible job-shop instance."
            )
        ),
    ],
    request: Request,
    response: Response,
    db: DbSession,
    _: Manager,
    dry_run: Annotated[
        bool,
        Query(
            description="Check the file and report what it would add, without keeping any of it."
        ),
    ] = False,
) -> ImportReportResponse | JSONResponse:
    """Add every machine, job, operation, route and precedence edge a file describes, or none.

    Every imported job is new and open in the backlog. Machines are matched by exact name, reused
    when the floor has them and never changed by an import. A file with any problem writes
    nothing, and the response lists every problem with where it is in the file. An import creates
    many resources and none is the primary one, so a `201` carries no `Location`; the new jobs are
    in `job_ids`. A dry run answers `200` whatever it finds.
    """

    if dry_run:
        response.status_code = status.HTTP_200_OK

    # Read before the transaction opens: parsing is pure and needs no connection.
    read = ImportService.Parsing.read_file(await file.read())
    match read:
        case FileUnreadable(issues=issues):
            if dry_run:
                return _report(None, None, dry_run=True, issues=issues, warnings=())
            return _import_invalid(request, issues, warnings=())
        case PlanRead(plan=plan):
            async with db.begin() as transaction:
                result = await ImportService.import_plan(
                    db,
                    plan,
                    operator_password=request.app.state.settings.operator_default_password,
                )
                match result:
                    case ImportApplied(summary=summary, job_ids=job_ids, warnings=warnings):
                        if dry_run:
                            await transaction.rollback()
                            return _report(
                                summary, plan, dry_run=True, issues=(), warnings=warnings
                            )
                        return _report(
                            summary,
                            plan,
                            dry_run=False,
                            issues=(),
                            warnings=warnings,
                            job_ids=job_ids,
                        )
                    case ImportRejected(summary=summary, issues=issues, warnings=warnings):
                        # Nearly always nothing to undo, but a late refusal follows machine inserts.
                        await transaction.rollback()
                        if dry_run:
                            return _report(
                                summary, plan, dry_run=True, issues=issues, warnings=warnings
                            )
                        return _import_invalid(request, issues, warnings=warnings)
                    case _:
                        assert_never(result)
        case _:
            assert_never(read)


def _report(
    summary: ImportSummary | None,
    plan: ImportPlan | None,
    *,
    dry_run: bool,
    issues: Sequence[ImportIssue],
    warnings: Sequence[ImportIssue],
    job_ids: Sequence[UUID] = (),
) -> ImportReportResponse:
    # The response schemas read attributes, so the result dataclasses go in as they are.
    return ImportReportResponse.model_validate(
        {
            "format": None if summary is None else summary.format,
            "dry_run": dry_run,
            "importable": not issues,
            "summary": summary,
            "jobs": None if plan is None else _job_previews(plan, issues, warnings),
            "job_ids": job_ids,
            "issues": issues,
            "warnings": warnings,
        }
    )


def _job_previews(
    plan: ImportPlan, issues: Sequence[ImportIssue], warnings: Sequence[ImportIssue]
) -> list[ImportJobPreviewResponse]:
    # Every place in the file that belongs to a job. An issue is about the job whose place is its
    # location, or the longest prefix of it that ends at a `.` or `[`. Locations differ by format
    # (`jobs[0].operations[1]`, `data (job 0, operation 1)`), so they are matched, not parsed.
    owners: dict[str, int] = {}
    for index, job in enumerate(plan.jobs):
        owners[job.location] = index
        for operation in job.operations:
            owners[operation.location] = index
            for route in operation.routes:
                owners[route.location] = index

    def owner(issue: ImportIssue) -> int | None:
        location = issue.location
        if location is None:
            return None
        if location in owners:
            return owners[location]
        for end in range(len(location) - 1, 0, -1):
            if location[end] in ".[" and location[:end] in owners:
                return owners[location[:end]]
        return None

    job_issues: list[list[ImportIssue]] = [[] for _ in plan.jobs]
    job_warnings: list[list[ImportIssue]] = [[] for _ in plan.jobs]
    for issue in issues:
        if (owned := owner(issue)) is not None:
            job_issues[owned].append(issue)
    for warning in warnings:
        if (owned := owner(warning)) is not None:
            job_warnings[owned].append(warning)

    return [
        _job_preview(job, job_issues[index], job_warnings[index])
        for index, job in enumerate(plan.jobs)
    ]


def _job_preview(
    job: PlannedJob, issues: Sequence[ImportIssue], warnings: Sequence[ImportIssue]
) -> ImportJobPreviewResponse:
    predecessors: list[list[int]] = [[] for _ in job.operations]
    for before, after in ImportService.Validation.precedence_edges(job):
        predecessors[after].append(before)
    return ImportJobPreviewResponse(
        name=job.name,
        priority=job.priority,
        location=job.location,
        operations=[
            ImportOperationPreviewResponse(
                name=operation.name,
                routes=[
                    ImportRoutePreviewResponse(
                        machine=route.machine, duration=route.duration, energy=route.energy
                    )
                    for route in operation.routes
                ],
                predecessors=predecessors[index],
            )
            for index, operation in enumerate(job.operations)
        ],
        issues=[ImportIssueResponse.model_validate(issue) for issue in issues],
        warnings=[ImportIssueResponse.model_validate(issue) for issue in warnings],
    )


def _import_invalid(
    request: Request, issues: Sequence[ImportIssue], *, warnings: Sequence[ImportIssue]
) -> JSONResponse:
    count = "1 problem" if len(issues) == 1 else f"{len(issues)} problems"
    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:import-invalid",
            title="Import file has problems",
            status=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Found {count} in the file, so nothing was imported.",
            instance=request.url.path,
        ),
        extensions={
            "issues": [
                ImportIssueResponse.model_validate(issue).model_dump(mode="json")
                for issue in issues
            ],
            "warnings": [
                ImportIssueResponse.model_validate(issue).model_dump(mode="json")
                for issue in warnings
            ],
        },
    )
