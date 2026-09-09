from datetime import datetime
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from pydantic import Field, StringConstraints, model_validator

from floorsync_api.schemas import RequestSchema, ResponseSchema

type ResourceName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class MachineCreateRequest(RequestSchema):
    """A machine a coordinator is adding to the floor.

    category_id and salary are optional: nothing in the scheduler reads a machine's category, and a
    machine with no recorded salary is excluded from a schedule's labour total rather than counted
    as free. Requiring either would block entering a machine whose details are not settled yet.
    """

    name: ResourceName
    category_id: UUID | None = None
    salary: Annotated[Decimal, Field(ge=0)] | None = None
    active: bool = True


class MachineUpdateRequest(RequestSchema):
    """A partial update. An omitted field is left alone; an explicit null clears it.

    Only the nullable columns may be cleared. `name` and `active` are NOT NULL, so an explicit null
    for either is rejected here rather than reaching the database as an integrity error.
    """

    name: ResourceName | None = None
    category_id: UUID | None = None
    salary: Annotated[Decimal, Field(ge=0)] | None = None
    active: bool | None = None

    @model_validator(mode="after")
    def reject_null_for_required_columns(self) -> "MachineUpdateRequest":
        nulled = [
            field
            for field in ("name", "active")
            if field in self.model_fields_set and getattr(self, field) is None
        ]
        if nulled:
            raise ValueError(f"{', '.join(nulled)} cannot be null")
        return self


class CapabilityUpsertRequest(RequestSchema):
    """What it costs this machine to run one operation.

    duration is occupancy in minutes and is always required -- an operation cannot be sequenced
    without one. energy stays optional for the same reason salary does.
    """

    duration: Annotated[int, Field(gt=0)]
    energy: Annotated[Decimal, Field(ge=0)] | None = None


class CategoryCreateRequest(RequestSchema):
    name: ResourceName


class CapabilityResponse(ResponseSchema):
    operation_id: UUID
    machine_id: UUID
    duration: int
    energy: Decimal | None


class MachineResponse(ResponseSchema):
    id: UUID
    name: str
    category_id: UUID | None
    salary: Decimal | None
    active: bool
    created_at: datetime
    updated_at: datetime


class MachineDetailResponse(MachineResponse):
    """A single machine with the operations it is declared able to run."""

    capabilities: list[CapabilityResponse]


class CategoryResponse(ResponseSchema):
    id: UUID
    name: str
    created_at: datetime
    updated_at: datetime
