from datetime import datetime

from floorsync_api.schemas import ResponseSchema


class LiveUpdateTicketResponse(ResponseSchema):
    """A one-time ticket to authenticate the `/ws` connection this account is about to open."""

    ticket: str
    expires_at: datetime
