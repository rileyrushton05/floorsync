from datetime import datetime
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from pydantic import Field, StringConstraints, model_validator

from floorsync_api.features.jobs.schemas import JobPriority
from floorsync_api.schemas import RequestSchema, ResponseSchema

type BuilderName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class BuilderRouteInput(RequestSchema):
    """What it costs one machine to run one operation, as the builder edits it."""

    machine_id: UUID
    duration_minutes: Annotated[int, Field(ge=1)]
    energy: Annotated[Decimal, Field(ge=0)] | None = None


def _reject_duplicate_machines(routes: list[BuilderRouteInput]) -> list[BuilderRouteInput]:
    machine_ids = [route.machine_id for route in routes]
    if len(machine_ids) != len(set(machine_ids)):
        raise ValueError("routes cannot repeat a machine_id within one operation")
    return routes


class BuilderOperationCreateInput(RequestSchema):
    """One new operation within a job definition being created."""

    name: BuilderName
    routes: Annotated[list[BuilderRouteInput], Field(min_length=1)]

    @model_validator(mode="after")
    def reject_duplicate_machines(self) -> "BuilderOperationCreateInput":
        _reject_duplicate_machines(self.routes)
        return self


class BuilderOperationReplaceInput(RequestSchema):
    """One operation within a replacement. Send an id to retain it; omit it for a new operation."""

    id: UUID | None = None
    name: BuilderName
    routes: Annotated[list[BuilderRouteInput], Field(min_length=1)]

    @model_validator(mode="after")
    def reject_duplicate_machines(self) -> "BuilderOperationReplaceInput":
        _reject_duplicate_machines(self.routes)
        return self


class JobDefinitionCreateRequest(RequestSchema):
    """A complete job a manager is creating in one request: its priority and every operation."""

    name: BuilderName
    priority: JobPriority
    operations: Annotated[list[BuilderOperationCreateInput], Field(min_length=1)]


class JobDefinitionReplaceRequest(RequestSchema):
    """A complete replacement for one job's definition.

    The array index of each operation is its 1-based position -- there is no caller-controlled
    position field, so drag-reorder has one unambiguous representation.
    """

    name: BuilderName
    priority: JobPriority
    operations: Annotated[list[BuilderOperationReplaceInput], Field(min_length=1)]

    @model_validator(mode="after")
    def reject_duplicate_operation_ids(self) -> "JobDefinitionReplaceRequest":
        ids = [operation.id for operation in self.operations if operation.id is not None]
        if len(ids) != len(set(ids)):
            raise ValueError("operations cannot repeat an id")
        return self


class BuilderRouteResponse(ResponseSchema):
    machine_id: UUID
    duration_minutes: int
    energy: Decimal | None


class BuilderOperationResponse(ResponseSchema):
    id: UUID
    position: int
    name: str
    routes: list[BuilderRouteResponse]


class JobDefinitionResponse(ResponseSchema):
    """The canonical shape of a job definition: everything the builder needs to redraw it."""

    id: UUID
    name: str
    priority: JobPriority
    created_at: datetime
    updated_at: datetime
    operations: list[BuilderOperationResponse]
