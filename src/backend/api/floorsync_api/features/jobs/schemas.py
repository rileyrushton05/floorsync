from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import StringConstraints, model_validator

from floorsync_api.schemas import RequestSchema, ResponseSchema

type JobName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
type JobPriority = Literal["high", "med", "low"]


class JobCreateRequest(RequestSchema):
    """A job a manager is adding to the backlog.

    Only a name: the operations inside a job are added separately, and job names are deliberately
    not unique because two real jobs can carry the same description. Priority is not settable here
    yet -- every job is created at the database default until the job-definition endpoint (#235)
    exists.
    """

    name: JobName


class JobUpdateRequest(RequestSchema):
    """A partial update. `name` is NOT NULL, so an explicit null is rejected rather than stored.

    `archived: true` retires the job from the backlog. Only `true` is accepted: archiving is one
    way (decision 0018), and a job a plan claimed comes back when that plan is discarded. It is a
    flag here rather than the timestamp the row stores, because the caller decides *whether* the
    job is archived and the server records *when*.
    """

    name: JobName | None = None
    archived: Literal[True] | None = None

    @model_validator(mode="after")
    def reject_explicit_nulls(self) -> "JobUpdateRequest":
        nulled = [
            field
            for field in ("name", "archived")
            if field in self.model_fields_set and getattr(self, field) is None
        ]
        if nulled:
            raise ValueError(f"{', '.join(nulled)} cannot be null")
        return self


class JobOperationResponse(ResponseSchema):
    """An operation as seen from its job. Managed through the operations API, not here."""

    id: UUID
    job_id: UUID
    name: str


class JobResponse(ResponseSchema):
    id: UUID
    name: str
    priority: JobPriority
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


class JobDetailResponse(JobResponse):
    """A single job with the operations it contains, in position order."""

    operations: list[JobOperationResponse]


class JobDependencyEdgeResponse(ResponseSchema):
    """One job that has to finish before another can start."""

    before_job_id: UUID
    after_job_id: UUID


class JobDependencyGraphResponse(ResponseSchema):
    """Which jobs wait on which, across the whole backlog.

    Derived from `dependencies`, which joins operations rather than jobs: an edge appears here
    only when its two operations belong to different jobs. Edges inside a single job order that
    job's own steps and are read through `GET /api/v1/jobs/{job_id}/dependencies` instead.

    Deliberately the whole graph in one response rather than a field on each job in the paginated
    job list. A job's prerequisites can sit on any page, and computing them per row would mean
    walking the dependency graph once per job on every page read. The payload is one row per
    cross-job edge, of which there are usually none.
    """

    edges: list[JobDependencyEdgeResponse]
