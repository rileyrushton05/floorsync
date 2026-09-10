from collections.abc import Mapping
from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

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
