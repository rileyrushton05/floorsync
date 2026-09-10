"""Database adapter for the ReSched scheduling policy."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.schedule import Schedule
from floorsync_common.database.models.schedule_dependency import ScheduleDependency
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.unavailability import Unavailability
from floorsync_common.scheduling.contracts import (
    DependencySpec,
    MachineSpec,
    OperationSpec,
    RouteSpec,
    SchedulePlan,
    SchedulingInput,
    UnavailabilitySpec,
)
from floorsync_common.scheduling.resched import ReSchedEngine


@dataclass(frozen=True, slots=True)
class ScheduleStored:
    """A draft schedule written in the caller's open transaction."""

    schedule: Schedule


class SchedulingService:
    """Read scheduling inputs and persist generated plans in caller-owned transactions."""

    strategy = ReSchedEngine.strategy

    @staticmethod
    def load_input(
        db: Session,
        *,
        starts_at: datetime,
    ) -> SchedulingInput:
        """Snapshot the current floor configuration for a later, transaction-free inference run."""

        machines = list(db.scalars(select(Machine)).all())
        operations = list(db.scalars(select(Operation)).all())
        routes = list(db.scalars(select(Compatibility)).all())
        dependencies = list(db.scalars(select(Dependency)).all())
        unavailabilities = list(db.scalars(select(Unavailability)).all())

        return SchedulingInput(
            starts_at=starts_at,
            machines=tuple(
                MachineSpec(
                    id=machine.id,
                    active=machine.active,
                    salary_per_minute=machine.salary,
                )
                for machine in machines
            ),
            operations=tuple(
                OperationSpec(id=operation.id, name=operation.name) for operation in operations
            ),
            routes=tuple(
                RouteSpec(
                    operation_id=route.operation_id,
                    machine_id=route.machine_id,
                    duration_minutes=route.duration,
                    energy=route.energy,
                )
                for route in routes
            ),
            dependencies=tuple(
                DependencySpec(
                    before_operation_id=dependency.before_operation_id,
                    after_operation_id=dependency.after_operation_id,
                )
                for dependency in dependencies
            ),
            unavailabilities=tuple(
                UnavailabilitySpec(
                    machine_id=window.machine_id,
                    starts_at=window.starts_at,
                    ends_at=window.ends_at,
                )
                for window in unavailabilities
            ),
        )

    @staticmethod
    def store_draft(
        db: Session,
        *,
        plan: SchedulePlan,
        runtime_ms: int,
        input_operation_count: int,
    ) -> ScheduleStored:
        """Write one generated plan without re-running inference or changing prior schedules."""

        schedule = Schedule(
            status="draft",
            strategy=SchedulingService.strategy,
            runtime_ms=runtime_ms,
            input_operation_count=input_operation_count,
            makespan=plan.metrics.makespan_minutes,
            total_energy=plan.metrics.total_energy,
            total_labour_cost=plan.metrics.total_labour_cost,
        )
        db.add(schedule)
        db.flush()

        entries_by_operation_id: dict[UUID, ScheduleEntry] = {}
        for assignment in plan.assignments:
            entry = ScheduleEntry(
                schedule_id=schedule.id,
                operation_id=assignment.operation_id,
                machine_id=assignment.machine_id,
                duration=assignment.duration_minutes,
                energy=assignment.energy,
                machine_salary=assignment.machine_salary_per_minute,
                start_time=assignment.starts_at,
            )
            db.add(entry)
            entries_by_operation_id[assignment.operation_id] = entry
        db.flush()

        for dependency in plan.dependencies:
            schedule_dependency = ScheduleDependency(
                schedule_entry_id=entries_by_operation_id[dependency.schedule_operation_id].id,
                depends_on_schedule_entry_id=entries_by_operation_id[
                    dependency.depends_on_operation_id
                ].id,
                reason=dependency.reason,
            )
            db.add(schedule_dependency)
        db.flush()
        return ScheduleStored(schedule=schedule)
