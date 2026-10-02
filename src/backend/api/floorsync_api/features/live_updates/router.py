"""HTTP route that issues the one-time ticket a client trades for a `/ws` connection."""

from fastapi import APIRouter, Request, Response, status
from fastapi.responses import JSONResponse
from redis.exceptions import RedisError

from floorsync_api.dependencies.authentication import CurrentUser
from floorsync_api.features.live_updates.schemas import LiveUpdateTicketResponse
from floorsync_api.features.live_updates.tickets import LiveUpdateTicketService
from floorsync_api.problems import ProblemDetail, problem_response

router = APIRouter(prefix="/live-updates", tags=["live-updates"])


@router.post(
    "/tickets",
    response_model=LiveUpdateTicketResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Issue a one-time ticket to authenticate a live-update WebSocket",
    responses={503: {"description": "Live updates are unavailable; fall back to polling"}},
)
async def create_ticket(
    current_user: CurrentUser, request: Request, response: Response
) -> LiveUpdateTicketResponse | JSONResponse:
    """Issue a short-lived, single-use ticket bound to the caller's account.

    Any signed-in account may request one -- the socket's own subscription check is what limits
    what that ticket can then see. Never cached: a ticket is single-use, so a cached response
    would hand out one that already looks valid but can never actually be redeemed twice.
    """
    response.headers["Cache-Control"] = "no-store"
    try:
        issued = await LiveUpdateTicketService.issue(user_id=current_user.id)
    except RedisError:
        # Redis down or hanging: say so as a 503 so the frontend can fall back to polling the REST
        # snapshot instead of treating it as a server bug.
        problem = problem_response(
            ProblemDetail(
                type="urn:floorsync:problem:live-updates-unavailable",
                title="Live updates are temporarily unavailable",
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Live updates are not available right now. Poll the simulation instead.",
                instance=request.url.path,
            )
        )
        # Headers set on the injected `response` are dropped when a route returns its own.
        problem.headers["Cache-Control"] = "no-store"
        return problem
    return LiveUpdateTicketResponse(ticket=issued.ticket, expires_at=issued.expires_at)
