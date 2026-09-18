"""HTTP route that issues the one-time ticket a client trades for a `/ws` connection."""

from fastapi import APIRouter, Response, status

from floorsync_api.dependencies.authentication import CurrentUser
from floorsync_api.features.live_updates.schemas import LiveUpdateTicketResponse
from floorsync_api.features.live_updates.tickets import LiveUpdateTicketService

router = APIRouter(prefix="/live-updates", tags=["live-updates"])


@router.post(
    "/tickets",
    response_model=LiveUpdateTicketResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Issue a one-time ticket to authenticate a live-update WebSocket",
)
async def create_ticket(current_user: CurrentUser, response: Response) -> LiveUpdateTicketResponse:
    """Issue a short-lived, single-use ticket bound to the caller's account.

    Any signed-in account may request one -- the socket's own subscription check is what limits
    what that ticket can then see. Never cached: a ticket is single-use, so a cached response
    would hand out one that already looks valid but can never actually be redeemed twice.
    """
    response.headers["Cache-Control"] = "no-store"
    issued = await LiveUpdateTicketService.issue(user_id=current_user.id)
    return LiveUpdateTicketResponse(ticket=issued.ticket, expires_at=issued.expires_at)
