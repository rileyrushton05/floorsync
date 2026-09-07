from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from floorsync_api.schemas import RequestSchema, ResponseSchema


class ScheduleCreateRequest(RequestSchema):
    """Request a draft schedule from the current floor configuration."""

    starts_at: datetime


class SchedulingIssueResponse(ResponseSchema):
    """One unsupported or invalid scheduling input reported by the adapter."""

    code: str
    message: str
    operation_id: UUID | None = None
    machine_id: UUID | None = None


class ScheduleGenerationAcceptedResponse(ResponseSchema):
    """A queued generation command and the resource used to observe it."""

    id: UUID
    status: Literal["pending"]
    status_url: str


class ScheduleGenerationStatusResponse(ResponseSchema):
    """The externally visible state of one queued schedule-generation command."""

    id: UUID
    status: Literal["pending", "running", "completed", "rejected", "unavailable", "failed"]
    schedule_id: UUID | None = None
    schedule_url: str | None = None
    issues: list[SchedulingIssueResponse] | None = None


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
