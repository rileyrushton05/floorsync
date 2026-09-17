from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from floorsync_api.schemas import RequestSchema, ResponseSchema


class ScheduleCreateRequest(RequestSchema):
    """Request a draft schedule from the current floor configuration.

    `job_ids` scopes the run to a chosen part of the backlog (#231). Omitting it plans the whole
    floor, which is what this request has always meant, so no existing caller changes behaviour.

    A selection is validated where the dependency graph is already being read, not here: an unknown
    job, a selection with no schedulable work, and a selection missing a job that a selected job
    waits on each come back through the generation status resource as a `rejected` outcome with its
    own issue code. See `GET /api/v1/jobs/dependency-graph` for working out what a selection
    implies before sending one.
    """

    starts_at: datetime
    strategy: Literal["resched", "exact"] = "resched"
    job_ids: list[UUID] | None = None


class SchedulingIssueResponse(ResponseSchema):
    """One unsupported or invalid scheduling input reported by the adapter.

    At most one of the three ids is set, naming whichever the issue is about, so a client can mark
    the offending row rather than parse `message`.
    """

    code: str
    message: str
    operation_id: UUID | None = None
    machine_id: UUID | None = None
    job_id: UUID | None = None


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
    status: Literal["draft", "confirmed", "discarded"]
    strategy: str
    makespan: int | None
    input_operation_count: int | None
    created_at: datetime
    confirmed_at: datetime | None


class ScheduleResponse(ResponseSchema):
    id: UUID
    status: Literal["draft", "confirmed", "discarded"]
    strategy: str
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
