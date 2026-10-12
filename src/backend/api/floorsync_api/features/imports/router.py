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
from floorsync_api.features.imports.schemas import ImportIssueResponse, ImportReportResponse
from floorsync_api.problems import ProblemDetail, problem_response
from floorsync_common.database.models.user import User
from floorsync_common.imports.plan import ImportIssue
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
                return _report(None, dry_run=True, issues=issues, warnings=())
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
                            return _report(summary, dry_run=True, issues=(), warnings=warnings)
                        return _report(
                            summary, dry_run=False, issues=(), warnings=warnings, job_ids=job_ids
                        )
                    case ImportRejected(summary=summary, issues=issues, warnings=warnings):
                        # Nearly always nothing to undo, but a late refusal follows machine inserts.
                        await transaction.rollback()
                        if dry_run:
                            return _report(summary, dry_run=True, issues=issues, warnings=warnings)
                        return _import_invalid(request, issues, warnings=warnings)
                    case _:
                        assert_never(result)
        case _:
            assert_never(read)


def _report(
    summary: ImportSummary | None,
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
            "job_ids": job_ids,
            "issues": issues,
            "warnings": warnings,
        }
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
