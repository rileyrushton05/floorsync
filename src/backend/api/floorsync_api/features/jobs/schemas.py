from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import StringConstraints, model_validator

from floorsync_api.schemas import RequestSchema, ResponseSchema

type JobName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class JobCreateRequest(RequestSchema):
    """A job a manager is adding to the backlog.

    Only a name: the operations inside a job are added separately, and job names are deliberately
    not unique because two real jobs can carry the same description.
    """

    name: JobName


class JobUpdateRequest(RequestSchema):
    """A partial update. `name` is NOT NULL, so an explicit null is rejected rather than stored."""

    name: JobName | None = None

    @model_validator(mode="after")
    def reject_null_name(self) -> "JobUpdateRequest":
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("name cannot be null")
        return self


class JobOperationResponse(ResponseSchema):
    """An operation as seen from its job. Managed through the operations API, not here."""

    id: UUID
    job_id: UUID
    name: str


class JobResponse(ResponseSchema):
    id: UUID
    name: str
    created_at: datetime
    updated_at: datetime


class JobDetailResponse(JobResponse):
    """A single job with the operations it contains."""

    operations: list[JobOperationResponse]
