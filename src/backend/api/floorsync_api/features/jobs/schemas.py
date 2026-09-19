from collections.abc import Iterable
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import StringConstraints, model_validator

from floorsync_api.schemas import RequestSchema, ResponseSchema
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.jobs.backlog import BacklogStatus, JobBacklog

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

    `archived` retires the job from the backlog (`true`) or brings it back (`false`). It is a
    boolean here rather than the timestamp the row stores, because the caller decides *whether* the
    job is archived and the server records *when*.
    """

    name: JobName | None = None
    archived: bool | None = None

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
    """A job and where it stands in the backlog.

    `backlog_status` is derived from the schedules that reference the job, never stored on it
    (decision 0019): `open` until a confirmed schedule plans it, `planned` once one does, `done`
    once that schedule's simulation completed, `archived` when a manager retired it by hand.
    `planned_by_schedule_ids` lists the confirmed schedules that plan it, oldest first, so a client
    can link to them.
    """

    id: UUID
    name: str
    priority: JobPriority
    archived_at: datetime | None
    backlog_status: BacklogStatus
    planned_by_schedule_ids: list[UUID]
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_job(cls, job: Job, backlog: JobBacklog) -> "JobResponse":
        return cls(
            id=job.id,
            name=job.name,
            priority=job.priority,
            archived_at=job.archived_at,
            backlog_status=backlog.status,
            planned_by_schedule_ids=list(backlog.schedule_ids),
            created_at=job.created_at,
            updated_at=job.updated_at,
        )


class JobDetailResponse(JobResponse):
    """A single job with the operations it contains, in position order."""

    operations: list[JobOperationResponse]

    @classmethod
    def from_job_and_operations(
        cls, job: Job, backlog: JobBacklog, operations: Iterable[Operation]
    ) -> "JobDetailResponse":
        return cls(
            **JobResponse.from_job(job, backlog).model_dump(),
            operations=[JobOperationResponse.model_validate(operation) for operation in operations],
        )


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
