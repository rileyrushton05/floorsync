from collections.abc import Mapping
from datetime import datetime
from http import HTTPStatus
from typing import assert_never
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from floorsync_common.jobs.backlog import JobBacklog
from floorsync_common.scheduling.references import ScheduleReferences

PROBLEM_MEDIA_TYPE = "application/problem+json"


class InvalidParameter(BaseModel):
    """One invalid request parameter in a validation problem."""

    name: str
    reason: str


class ProblemDetail(BaseModel):
    """RFC 9457 problem detail response."""

    type: str = Field(default="about:blank", min_length=1)
    title: str
    status: int = Field(ge=100, le=599)
    detail: str | None = None
    instance: str | None = None
    invalid_params: list[InvalidParameter] | None = None


def _status_title(status_code: int) -> str:
    try:
        return HTTPStatus(status_code).phrase
    except ValueError:
        return "HTTP error"


def problem_response(
    problem: ProblemDetail,
    *,
    headers: Mapping[str, str] | None = None,
    extensions: Mapping[str, object] | None = None,
) -> JSONResponse:
    """Render a problem detail with optional RFC 9457 extension members."""

    content = problem.model_dump(exclude_none=True)
    if extensions is not None:
        content.update(extensions)
    return JSONResponse(
        status_code=problem.status,
        content=content,
        headers=headers,
        media_type=PROBLEM_MEDIA_TYPE,
    )


def schedule_references_members(references: ScheduleReferences) -> dict[str, object]:
    """Extension members naming the schedules that stand in the way of removing some work.

    Three features refuse a removal for the same reason (a schedule entry points at the work) and
    render the same two lists, so the shape is defined once: `draft_schedule_ids`, which the caller
    can delete to clear the way, and `confirmed_schedule_ids`, which it cannot (decision 0015).
    """

    return {
        "draft_schedule_ids": [str(schedule_id) for schedule_id in references.draft_schedule_ids],
        "confirmed_schedule_ids": [
            str(schedule_id) for schedule_id in references.confirmed_schedule_ids
        ],
    }


def schedule_references_hint(references: ScheduleReferences) -> str:
    """One sentence on what the caller can do about the schedules in the way, for a detail."""

    drafts = len(references.draft_schedule_ids)
    if references.confirmed_schedule_ids:
        return (
            "At least one of those schedules is confirmed, which is a record of what the floor was "
            "told to do, so this cannot be removed; archive the job instead."
        )
    return (
        f"Only draft schedules ({drafts}) reference it: delete them through "
        "DELETE /api/v1/schedules/{schedule_id} and retry."
    )


def job_has_left_backlog_problem(
    request: Request, job_id: UUID, backlog: JobBacklog, archived_at: datetime | None
) -> JSONResponse:
    """The 409 every write to a job that is not open returns (decisions 0018, 0019).

    Six routes across three features refuse for the same reason, so the type, title and the way
    out are defined once. The extension members say why (`backlog_status`), which schedules hold
    the job (`planned_by_schedule_ids`) and, for an archived job, since when.
    """

    match backlog.status:
        case "planned":
            detail = (
                "A confirmed schedule already plans this job, so its definition is read-only. "
                "Discard that schedule to bring the job back, or duplicate the job and edit the "
                "copy."
            )
        case "done":
            detail = (
                "This job has been run, so its definition is read-only. Duplicate it and edit "
                "the copy."
            )
        case "archived":
            detail = (
                "This job is archived, so its definition is read-only. Duplicate it and edit the "
                "copy."
            )
        case "open":
            raise ValueError("An open job is not refused.")
        case _:
            assert_never(backlog.status)

    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:job-has-left-backlog",
            title="Job has left the backlog",
            status=HTTPStatus.CONFLICT,
            detail=detail,
            instance=request.url.path,
        ),
        extensions={
            "job_id": str(job_id),
            "backlog_status": backlog.status,
            "planned_by_schedule_ids": [str(schedule_id) for schedule_id in backlog.schedule_ids],
            "archived_at": None if archived_at is None else archived_at.isoformat(),
        },
    )


async def http_problem_handler(
    request: Request,
    exc: StarletteHTTPException,
) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, str) else None
    problem = ProblemDetail(
        title=_status_title(exc.status_code),
        status=exc.status_code,
        detail=detail,
        instance=request.url.path,
    )
    return problem_response(problem, headers=exc.headers)


async def validation_problem_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    invalid_params = [
        InvalidParameter(
            name=".".join(str(part) for part in error["loc"]),
            reason=error["msg"],
        )
        for error in exc.errors()
    ]
    problem = ProblemDetail(
        type="urn:floorsync:problem:request-validation",
        title="Request validation failed",
        status=422,
        detail="One or more request parameters were invalid.",
        instance=request.url.path,
        invalid_params=invalid_params,
    )
    return problem_response(problem)


def install_problem_handlers(app: FastAPI) -> None:
    """Install the project's RFC 9457 handlers on a FastAPI application."""

    # FastAPI's handler protocol is not generic over the concrete exception type.
    app.add_exception_handler(StarletteHTTPException, http_problem_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, validation_problem_handler)  # type: ignore[arg-type]
