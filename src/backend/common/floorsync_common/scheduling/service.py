"""Database adapter for the ReSched scheduling policy."""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.schedule import SCHEDULE_DRAFT, Schedule
from floorsync_common.database.models.schedule_dependency import ScheduleDependency
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.schedule_job_selection import ScheduleJobSelection
from floorsync_common.database.models.unavailability import Unavailability
from floorsync_common.jobs.backlog import derive_backlog, planned_jobs_statement
from floorsync_common.jobs.dependency_graph import job_dependency_edges_statement
from floorsync_common.scheduling.contracts import (
    DependencySpec,
    MachineSpec,
    OperationSpec,
    RouteSpec,
    SchedulePlan,
    SchedulingInput,
    SchedulingInputInvalid,
    UnavailabilitySpec,
)
from floorsync_common.scheduling.resched import ReSchedEngine
from floorsync_common.scheduling.selection import no_schedulable_work_issue, selection_issues


@dataclass(frozen=True, slots=True)
class ScheduleStored:
    """A draft schedule written in the caller's open transaction."""

    schedule: Schedule


type LoadInputResult = SchedulingInput | SchedulingInputInvalid
"""A snapshot ready for the engine, or the refusal of a selection that cannot become one."""


class SchedulingService:
    """Read scheduling inputs and persist generated plans in caller-owned transactions."""

    strategy = ReSchedEngine.strategy

    @staticmethod
    def load_input(
        db: Session,
        *,
        starts_at: datetime,
        job_ids: Collection[UUID],
    ) -> LoadInputResult:
        """Snapshot the chosen jobs for a later, transaction-free inference run.

        `job_ids` is the manager's selection and is required: a run always plans a chosen part of
        the backlog, never "everything" (decision 0013 as amended by #270), so the backlog page is
        the one place that decides what a run contains.

        A selection is refused rather than quietly narrowed. Validating here rather than in the
        API is deliberate: the checks need the dependency graph and the backlog, this is the
        transaction that already reads them, and a refusal then reaches the client through the
        same `SchedulingInputInvalid` path the adapter's own refusals use. Refusing rather than
        adding the missing jobs is the contract #231 asks for -- returning a schedule containing
        jobs the caller did not ask for is worse than saying which ones are missing, and the
        manager's backlog is expected to tick them itself before ever sending one.
        """

        selection = frozenset(job_ids)
        known = db.execute(select(Job.id, Job.archived_at).where(Job.id.in_(selection))).tuples()
        known_jobs = list(known)
        plans = db.execute(planned_jobs_statement([job_id for job_id, _ in known_jobs])).tuples()
        issues = selection_issues(
            selection,
            known_job_ids=[job_id for job_id, _ in known_jobs],
            backlog=derive_backlog(known_jobs, plans),
            job_edges=list(db.execute(job_dependency_edges_statement()).tuples()),
        )
        if issues:
            return SchedulingInputInvalid(issues=issues)

        # Machines are never filtered. A machine belongs to the floor, not to a job, and an active
        # machine that no selected operation can run is harmless -- the adapter only ever reads a
        # machine through a route. Narrowing them would instead risk `no_compatible_machine` for an
        # operation whose only machine was dropped for belonging to no selected job, which is not a
        # thing a machine can do.
        machines = list(db.scalars(select(Machine)).all())

        operations = list(
            db.scalars(select(Operation).where(Operation.job_id.in_(selection))).all()
        )
        operation_ids = {operation.id for operation in operations}
        if not operation_ids:
            return SchedulingInputInvalid(issues=(no_schedulable_work_issue(),))

        # Routes and edges are narrowed to the operations in the snapshot, so an edge whose other
        # end was left out is dropped rather than left pointing at an operation the snapshot does
        # not contain (which the adapter would refuse as `unknown_dependency_operation`). An
        # outbound edge goes this way when its dependant was simply not selected. An inbound one
        # can only come from a job that has left the backlog (archived, or planned by a confirmed
        # schedule): `job_dependency_edges_statement` treats that prerequisite as satisfied, so
        # the selection check above did not demand it, and dropping the edge here is the same
        # reading.
        route_statement = select(Compatibility).where(Compatibility.operation_id.in_(operation_ids))
        dependency_statement = select(Dependency).where(
            Dependency.before_operation_id.in_(operation_ids),
            Dependency.after_operation_id.in_(operation_ids),
        )
        routes = list(db.scalars(route_statement).all())
        dependencies = list(db.scalars(dependency_statement).all())
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
        strategy: str | None = None,
        job_ids: Collection[UUID],
    ) -> ScheduleStored:
        """Write one generated plan without re-running inference or changing prior schedules.

        `job_ids` is the selection the run was asked for, written verbatim rather than derived from
        the plan: a selected job holding no schedulable work would otherwise vanish from the record.
        Schedules made before #231, and seeded ones, have no selection rows (see
        `ScheduleJobSelection`).
        """

        schedule = Schedule(
            status=SCHEDULE_DRAFT,
            strategy=strategy or SchedulingService.strategy,
            runtime_ms=runtime_ms,
            input_operation_count=input_operation_count,
            makespan=plan.metrics.makespan_minutes,
            total_energy=plan.metrics.total_energy,
            total_labour_cost=plan.metrics.total_labour_cost,
        )
        db.add(schedule)
        db.flush()

        for job_id in sorted(set(job_ids)):
            db.add(ScheduleJobSelection(schedule_id=schedule.id, job_id=job_id))

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
