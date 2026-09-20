import asyncio
from dataclasses import asdict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from floorsync_api.features.live_updates.health import build_report
from floorsync_api.features.live_updates.websocket import hub as live_update_hub
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


@router.get(
    "/health/live-updates",
    summary="Check live-update delivery health",
    responses={503: {"description": "Live delivery is degraded"}},
)
async def live_updates_health(request: Request) -> JSONResponse:
    """Report on the live-update subsystem alone.

    Deliberately not folded into `/health/ready`: Redis being down must not pull this instance out
    of rotation for ordinary REST traffic (decision 0017's whole premise), so this is a signal for
    whoever wants to alert on live delivery specifically, not a traffic gate.
    """

    report = await build_report(
        subscriber=request.app.state.live_update_subscriber,
        relay=request.app.state.live_update_relay,
        hub=live_update_hub,
    )
    return JSONResponse(
        status_code=200 if report.status == "ok" else 503,
        content={"service": "api", **asdict(report)},
    )
