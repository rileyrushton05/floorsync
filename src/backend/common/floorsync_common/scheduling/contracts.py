"""Framework-independent FloorSync scheduling contracts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from floorsync_common.outcomes import ExpectedOutcome


@dataclass(frozen=True, slots=True)
class MachineSpec:
    id: UUID
    active: bool
    salary_per_minute: Decimal | None


@dataclass(frozen=True, slots=True)
class OperationSpec:
    id: UUID
    name: str


@dataclass(frozen=True, slots=True)
class RouteSpec:
    """One operation-machine processing option."""

    operation_id: UUID
    machine_id: UUID
    duration_minutes: int
    energy: Decimal | None


@dataclass(frozen=True, slots=True)
class DependencySpec:
    before_operation_id: UUID
    after_operation_id: UUID


@dataclass(frozen=True, slots=True)
class UnavailabilitySpec:
    machine_id: UUID
    starts_at: datetime
    ends_at: datetime


@dataclass(frozen=True, slots=True)
class SchedulingInput:
    starts_at: datetime
    machines: tuple[MachineSpec, ...]
    operations: tuple[OperationSpec, ...]
    routes: tuple[RouteSpec, ...]
    dependencies: tuple[DependencySpec, ...]
    unavailabilities: tuple[UnavailabilitySpec, ...] = ()


@dataclass(frozen=True, slots=True)
class SchedulingIssue:
    """One reason an input was refused, naming whichever record it is about.

    `job_id` and `schedule_id` come last so the positional construction the adapter uses
    throughout (`SchedulingIssue(code, message, operation_id, machine_id)`) keeps working
    unchanged. `schedule_id` accompanies `job_id` when the reason is a schedule that already
    plans the job.
    """

    code: str
    message: str
    operation_id: UUID | None = None
    machine_id: UUID | None = None
    job_id: UUID | None = None
    schedule_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class SchedulingInputInvalid(ExpectedOutcome):
    issues: tuple[SchedulingIssue, ...]


@dataclass(frozen=True, slots=True)
class ScheduledOperation:
    operation_id: UUID
    machine_id: UUID
    starts_at: datetime
    ends_at: datetime
    duration_minutes: int
    energy: Decimal | None
    machine_salary_per_minute: Decimal | None


@dataclass(frozen=True, slots=True)
class ScheduleDependencySpec:
    schedule_operation_id: UUID
    depends_on_operation_id: UUID
    reason: Literal["job_order", "machine_queue"]


@dataclass(frozen=True, slots=True)
class ScheduleMetrics:
    makespan_minutes: int
    total_energy: Decimal | None
    total_labour_cost: Decimal | None


@dataclass(frozen=True, slots=True)
class SchedulePlan:
    assignments: tuple[ScheduledOperation, ...]
    dependencies: tuple[ScheduleDependencySpec, ...]
    metrics: ScheduleMetrics


@dataclass(frozen=True, slots=True)
class ScheduleGenerated:
    plan: SchedulePlan
