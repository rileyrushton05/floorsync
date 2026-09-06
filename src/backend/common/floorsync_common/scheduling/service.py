"""Database adapter for the ReSched scheduling policy."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from time import perf_counter_ns
from typing import assert_never
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
    ScheduleGenerated,
    SchedulingInput,
    SchedulingInputInvalid,
    UnavailabilitySpec,
)
from floorsync_common.scheduling.resched import ReSchedEngine, ReSchedRuntimeUnavailable


@dataclass(frozen=True, slots=True)
class ScheduleStored:
    """A complete draft schedule written in the caller's open transaction."""

    schedule: Schedule


type GenerateAndStoreScheduleResult = (
    ScheduleStored | SchedulingInputInvalid | ReSchedRuntimeUnavailable
)


class SchedulingService:
    """Load the live configuration, schedule it and write a new draft version.

    The caller owns the transaction. No input row or confirmed schedule is updated by this service.
    """

    strategy = ReSchedEngine.strategy

    @staticmethod
    async def generate_draft(
        db: AsyncSession,
        *,
        starts_at: datetime,
    ) -> GenerateAndStoreScheduleResult:
        """Generate one draft from a consistent read of the current floor configuration."""

        machines = list((await db.scalars(select(Machine))).all())
        operations = list((await db.scalars(select(Operation))).all())
        routes = list((await db.scalars(select(Compatibility))).all())
        dependencies = list((await db.scalars(select(Dependency))).all())
        unavailabilities = list((await db.scalars(select(Unavailability))).all())

        problem = SchedulingInput(
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
        started_ns = perf_counter_ns()
        result = ReSchedEngine.generate(problem)
        runtime_ms = (perf_counter_ns() - started_ns) // 1_000_000
        match result:
            case SchedulingInputInvalid():
                return result
            case ReSchedRuntimeUnavailable():
                return result
            case ScheduleGenerated(plan=plan):
                pass
            case _:
                assert_never(result)

        schedule = Schedule(
            status="draft",
            strategy=SchedulingService.strategy,
            runtime_ms=runtime_ms,
            input_operation_count=len(problem.operations),
            makespan=plan.metrics.makespan_minutes,
            total_energy=plan.metrics.total_energy,
            total_labour_cost=plan.metrics.total_labour_cost,
        )
        db.add(schedule)
        await db.flush()

        entries_by_operation_id: dict[UUID, ScheduleEntry] = {}
        for assignment in plan.assignments:
            entry = ScheduleEntry(
                schedule_id=schedule.id,
                operation_id=assignment.operation_id,
                machine_id=assignment.machine_id,
                starts_at=assignment.starts_at,
                ends_at=assignment.ends_at,
                duration=assignment.duration_minutes,
                energy=assignment.energy,
                machine_salary=assignment.machine_salary_per_minute,
            )
            db.add(entry)
            entries_by_operation_id[assignment.operation_id] = entry
        await db.flush()

        for dependency in plan.dependencies:
            db.add(
                ScheduleDependency(
                    schedule_entry_id=entries_by_operation_id[dependency.schedule_operation_id].id,
                    depends_on_schedule_entry_id=entries_by_operation_id[
                        dependency.depends_on_operation_id
                    ].id,
                    reason=dependency.reason,
                )
            )
        await db.flush()
        return ScheduleStored(schedule=schedule)
