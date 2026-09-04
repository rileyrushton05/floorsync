from typing import Literal
from uuid import UUID

from floorsync_api.schemas import ResponseSchema

type UserRole = Literal["manager", "operator"]


class AccessTokenResponse(ResponseSchema):
    """A bearer token returned by a successful local sign-in."""

    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class CurrentUserResponse(ResponseSchema):
    """The safe subset of the signed-in account exposed to the frontend."""

    id: UUID
    name: str
    role: UserRole
    machine_id: UUID | None
