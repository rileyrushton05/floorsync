from pydantic import BaseModel, ConfigDict


class RequestSchema(BaseModel):
    """Reject unknown client input instead of silently discarding it."""

    model_config = ConfigDict(extra="forbid")


class ResponseSchema(BaseModel):
    """Allow response contracts to validate SQLAlchemy/domain objects."""

    model_config = ConfigDict(from_attributes=True)


class CursorPage[ResponseItem](ResponseSchema):
    """Stable response envelope for cursor-paginated collections."""

    items: list[ResponseItem]
    next_cursor: str | None = None
