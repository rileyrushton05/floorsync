from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StringConstraints, model_validator

from floorsync_api.schemas import RequestSchema, ResponseSchema

type ScheduleName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)
]


class ScheduleCreateRequest(RequestSchema):
    """Request a draft schedule for a chosen set of jobs.

    `job_ids` is the manager's selection and is required (#231, #270): a run always plans a
    chosen part of the backlog, never "everything", so the backlog page is the one place that
    decides what a run contains.

    A selection is validated where the dependency graph is already being read, not here: an unknown
    job, an archived or already planned job, a selection with no schedulable work, and a selection
    missing a job that a selected job waits on each come back through the generation status
    resource as a `rejected` outcome with its own issue code. See
    `GET /api/v1/jobs/dependency-graph` for working out what a selection implies before sending
    one.
    """

    starts_at: datetime
    strategy: Literal["resched", "exact"] = "resched"
    job_ids: list[UUID] = Field(min_length=1)


class SchedulingIssueResponse(ResponseSchema):
    """One unsupported or invalid scheduling input reported by the adapter.

    The ids name whichever record the issue is about, so a client can mark the offending row
    rather than parse `message`. `schedule_id` accompanies `job_id` on `planned_job`: the confirmed
    schedule that already plans the job.
    """

    code: str
    message: str
    operation_id: UUID | None = None
    machine_id: UUID | None = None
    job_id: UUID | None = None
    schedule_id: UUID | None = None


class ScheduleGenerationAcceptedResponse(ResponseSchema):
    """A queued generation command and the resource used to observe it."""

    id: UUID
    status: Literal["pending"]
    status_url: str


class ScheduleGenerationStatusResponse(ResponseSchema):
    """The externally visible state of one queued schedule-generation command.

    Terminal operational failures include a safe, API-authored detail. It is
    intentionally not a worker exception: clients can show it directly while
    operational diagnostics remain in worker logs.
    """

    id: UUID
    status: Literal["pending", "running", "completed", "rejected", "unavailable", "failed"]
    schedule_id: UUID | None = None
    schedule_url: str | None = None
    issues: list[SchedulingIssueResponse] | None = None
    detail: str | None = None


class ScheduleEntryResponse(ResponseSchema):
    id: UUID
    operation_id: UUID
    machine_id: UUID
    duration: int
    energy: Decimal | None
    machine_salary: Decimal | None


class ScheduleDependencyResponse(ResponseSchema):
    id: UUID
    schedule_entry_id: UUID
    depends_on_schedule_entry_id: UUID
    reason: Literal["job_order", "machine_queue"]


class ScheduleSummaryResponse(ResponseSchema):
    """One schedule without its entries, for choosing between them.

    A schedule's entries and dependency graph run to hundreds of rows each, so
    the collection answers summaries and a caller fetches the one it wants.
    """

    id: UUID
    name: str | None
    status: Literal["draft", "confirmed", "discarded"]
    strategy: str
    starts_at: datetime
    makespan: int | None
    input_operation_count: int | None
    created_at: datetime
    confirmed_by_user_id: UUID | None
    confirmed_at: datetime | None


class ScheduleUpdateRequest(RequestSchema):
    """A rename, a lifecycle transition (decision 0015), or both at once.

    `confirmed` makes a draft the plan, or restores a discarded one; `discarded` withdraws a
    confirmed schedule the floor has not acted on. There is no way back to `draft`: a draft that
    is not wanted is deleted. Repeating the schedule's current status is a harmless no-op.

    `name` can be set in any status, since it labels the run rather than changing what it planned.
    Sending both is how the Planner saves: name the draft and confirm it in one request, so a
    refused transition never leaves a renamed draft behind. Explicit nulls are rejected.
    """

    status: Literal["confirmed", "discarded"] | None = None
    name: ScheduleName | None = None

    @model_validator(mode="after")
    def require_a_change(self) -> "ScheduleUpdateRequest":
        nulled = [
            field
            for field in ("status", "name")
            if field in self.model_fields_set and getattr(self, field) is None
        ]
        if nulled:
            raise ValueError(f"{', '.join(nulled)} cannot be null")
        if self.status is None and self.name is None:
            raise ValueError("send a status, a name, or both")
        return self


class ScheduleResponse(ResponseSchema):
    """One schedule with its entries, dependency graph, and the jobs it was asked to plan.

    `job_ids` is the selection the generation request named, which can include a job that held no
    schedulable work and so has no entries. It is null for a schedule made for the whole floor: a
    seeded one, or one generated before runs took a selection (#231).
    """

    id: UUID
    name: str | None
    status: Literal["draft", "confirmed", "discarded"]
    strategy: str
    starts_at: datetime
    runtime_ms: int | None
    input_operation_count: int | None
    makespan: int | None
    total_energy: Decimal | None
    total_labour_cost: Decimal | None
    created_at: datetime
    confirmed_by_user_id: UUID | None
    confirmed_at: datetime | None
    entries: list[ScheduleEntryResponse]
    dependencies: list[ScheduleDependencyResponse]
    job_ids: list[UUID] | None


class StrategyLimitResponse(ResponseSchema):
    """One thing a named strategy cannot take, on data that is otherwise coherent."""

    strategy: Literal["resched", "exact"]
    issue: SchedulingIssueResponse


class ScheduleValidationResponse(ResponseSchema):
    """What is wrong with the floor, or the selection, before anyone asks for a schedule (#133).

    `issues` stop every strategy and name the record at fault. `warnings` stop nothing: a job with
    no operations, a machine nothing can run on. `unsupported` is per strategy: fan-in is valid
    data the exact solver takes and ReSched does not, so it is reported against `resched` rather
    than as a fault in the floor. `schedulable` is the yes/no the scheduler page needs per
    strategy, and is exactly `not issues and nothing unsupported for that strategy`.
    """

    schedulable: dict[Literal["resched", "exact"], bool]
    issues: list[SchedulingIssueResponse]
    warnings: list[SchedulingIssueResponse]
    unsupported: list[StrategyLimitResponse]
