import asyncio

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from floorsync_common.database.session import session_scope
from floorsync_common.settings import settings

router = APIRouter(tags=["system"])


@router.get("/health")
def health() -> dict[str, str]:
    """Backward-compatible shallow health endpoint."""

    return {"status": "ok", "service": "api"}


@router.get("/health/live", summary="Check API process liveness")
def liveness() -> dict[str, str]:
    """Report whether the process and event loop can serve a request."""

    return {"status": "live", "service": "api"}


async def database_is_ready() -> bool:
    """Check the required database dependency within a short timeout."""

    try:
        async with asyncio.timeout(settings.readiness_timeout_seconds):
            async with session_scope() as session:
                await session.execute(text("SELECT 1"))
    except Exception:
        return False
    return True


@router.get(
    "/health/ready",
    summary="Check API dependency readiness",
    responses={503: {"description": "A required dependency is unavailable"}},
)
async def readiness() -> JSONResponse:
    """Report whether this instance should receive application traffic."""

    ready = await database_is_ready()
    return JSONResponse(
        status_code=200 if ready else 503,
        content={
            "status": "ready" if ready else "not_ready",
            "service": "api",
        },
    )
