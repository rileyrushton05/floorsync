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
    ImportReportResponse,
    ImportSummaryResponse,
)
from floorsync_api.problems import ProblemDetail, problem_response
from floorsync_common.database.models.user import User
from floorsync_common.imports.plan import ImportIssue, ImportPlan
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
    read = ImportService.read_file(await file.read())
    match read:
        case FileUnreadable(issues=issues):
            if dry_run:
                return _report(None, None, dry_run=True, issues=issues, warnings=(), job_ids=())
            return _import_invalid(request, issues, warnings=())
        case PlanRead(plan=plan):
            return await _import(plan, request, db, dry_run=dry_run)
        case _:
            assert_never(read)


async def _import(
    plan: ImportPlan, request: Request, db: DbSession, *, dry_run: bool
) -> ImportReportResponse | JSONResponse:
    async with db.begin() as transaction:
        result = await ImportService.import_plan(db, plan)
        match result:
            case ImportApplied():
                if dry_run:
                    await transaction.rollback()
            case ImportRejected():
                # Nearly always nothing to undo, but a late refusal follows machine inserts.
                await transaction.rollback()
            case _:
                assert_never(result)

    match result:
        case ImportApplied(summary=summary, job_ids=job_ids, warnings=warnings):
            return _report(
                plan,
                summary,
                dry_run=dry_run,
                issues=(),
                warnings=warnings,
                job_ids=() if dry_run else job_ids,
            )
        case ImportRejected(summary=summary, issues=issues, warnings=warnings):
            if dry_run:
                return _report(
                    plan, summary, dry_run=True, issues=issues, warnings=warnings, job_ids=()
                )
            return _import_invalid(request, issues, warnings=warnings)
        case _:
            assert_never(result)


def _report(
    plan: ImportPlan | None,
    summary: ImportSummary | None,
    *,
    dry_run: bool,
    issues: Sequence[ImportIssue],
    warnings: Sequence[ImportIssue],
    job_ids: Sequence[UUID],
) -> ImportReportResponse:
    return ImportReportResponse(
        format=None if plan is None else plan.format,
        dry_run=dry_run,
        importable=not issues,
        summary=None
        if summary is None
        else ImportSummaryResponse(
            machines_created=list(summary.machines_created),
            machines_reused=list(summary.machines_reused),
            categories_created=list(summary.categories_created),
            jobs=summary.jobs,
            operations=summary.operations,
            routes=summary.routes,
            dependencies=summary.dependencies,
        ),
        job_ids=list(job_ids),
        issues=[_issue(issue) for issue in issues],
        warnings=[_issue(issue) for issue in warnings],
    )


def _issue(issue: ImportIssue) -> ImportIssueResponse:
    return ImportIssueResponse(code=issue.code, message=issue.message, location=issue.location)


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
            "issues": [_issue(issue).model_dump() for issue in issues],
            "warnings": [_issue(issue).model_dump() for issue in warnings],
        },
    )
