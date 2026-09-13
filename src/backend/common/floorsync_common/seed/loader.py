"""Write a parsed benchmark instance into the database, replacing whatever was there before.

Only one scenario is loaded at a time: seeding clears the scheduling core first, so the database
always reflects exactly one instance rather than an accumulation of several.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import pairwise
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models import (
    Category,
    Compatibility,
    Dependency,
    Job,
    Machine,
    Operation,
    Schedule,
    ScheduleDependency,
    ScheduleEntry,
    Simulation,
    SimulationEvent,
    Unavailability,
    User,
    UserCredential,
)
from floorsync_common.seed.flexible import FlexibleInstance
from floorsync_common.seed.instances import BenchmarkInstance
from floorsync_common.seed.solutions import (
    BenchmarkSolution,
    validate_against,
    validate_flexible_against,
)

# Children before parents. Users are handled separately: an operator's login is bound to a machine
# by a check constraint, so it has to go before the machine it points at.
_CLEAR_ORDER = (
    SimulationEvent,
    Simulation,
    ScheduleDependency,
    ScheduleEntry,
    Schedule,
    Compatibility,
    Dependency,
    Operation,
    Job,
    Unavailability,
)


@dataclass(frozen=True, slots=True)
class SeedSummary:
    """What a seed run actually wrote, for reporting back to whoever ran it."""

    instance: str
    family: str
    machines: int
    jobs: int
    operations: int
    dependencies: int
    compatibilities: int
    removed_operator_logins: int
    solver: str | None = None
    makespan: int | None = None
    schedule_entries: int = 0
    schedule_dependencies: int = 0


async def seed_instance(
    session: AsyncSession,
    instance: BenchmarkInstance,
    solution: BenchmarkSolution | None = None,
) -> SeedSummary:
    """Replace the current scenario with `instance`, and its schedule when one is supplied.

    The caller owns the transaction, so a failure part-way leaves the database untouched rather than
    half-seeded.
    """

    if solution is not None:
        validate_against(solution, instance)

    removed_logins = await clear_scheduling_data(session)

    machine_ids = [uuid4() for _ in range(instance.machine_count)]
    job_ids = [uuid4() for _ in range(instance.job_count)]
    machine_width = _index_width(instance.machine_count)
    job_width = _index_width(instance.job_count)

    await _insert_all(
        session,
        Machine,
        [
            {"id": machine_id, "name": f"{instance.name}/M{index:0{machine_width}d}"}
            for index, machine_id in enumerate(machine_ids)
        ],
    )
    await _insert_all(
        session,
        Job,
        [{"id": job_id, "name": f"J{index:0{job_width}d}"} for index, job_id in enumerate(job_ids)],
    )

    operation_rows: list[dict[str, Any]] = []
    dependency_rows: list[dict[str, Any]] = []
    compatibility_rows: list[dict[str, Any]] = []
    # Keyed by (job, operation index) so a solution's machine sequences can be resolved back to the
    # operations they order.
    operation_ids: dict[tuple[int, int], UUID] = {}

    for job, operations in instance.operations_by_job.items():
        operation_width = _index_width(len(operations))
        previous_id: UUID | None = None
        # `position` is the builder's display order, numbered from 1 in the file's own sequence.
        for position, operation in enumerate(operations, start=1):
            operation_id = uuid4()
            operation_ids[(operation.job, operation.index)] = operation_id
            operation_rows.append(
                {
                    "id": operation_id,
                    "job_id": job_ids[job],
                    "name": f"Op{operation.index:0{operation_width}d}",
                    "position": position,
                }
            )
            # The file states precedence only as operation order within a job, so each step depends
            # on the one before it -- a simple chain, not the fan-in the schema also supports.
            # Imported edges are `legacy`: a later builder save must leave them alone.
            if previous_id is not None:
                dependency_rows.append(
                    {
                        "id": uuid4(),
                        "before_operation_id": previous_id,
                        "after_operation_id": operation_id,
                        "origin": "legacy",
                    }
                )
            compatibility_rows.append(
                {
                    "id": uuid4(),
                    "operation_id": operation_id,
                    "machine_id": machine_ids[operation.machine],
                    "duration": operation.duration,
                }
            )
            previous_id = operation_id

    await _insert_all(session, Operation, operation_rows)
    await _insert_all(session, Dependency, dependency_rows)
    await _insert_all(session, Compatibility, compatibility_rows)

    entry_count = 0
    queue_count = 0
    if solution is not None:
        entry_count, queue_count = await _seed_schedule(
            session, instance, solution, operation_ids, machine_ids
        )

    return SeedSummary(
        instance=instance.name,
        family=instance.family,
        machines=len(machine_ids),
        jobs=len(job_ids),
        operations=len(operation_rows),
        dependencies=len(dependency_rows),
        compatibilities=len(compatibility_rows),
        removed_operator_logins=removed_logins,
        solver=solution.solver if solution else None,
        makespan=solution.makespan if solution else None,
        schedule_entries=entry_count,
        schedule_dependencies=queue_count,
    )


async def _seed_schedule(
    session: AsyncSession,
    instance: BenchmarkInstance,
    solution: BenchmarkSolution,
    operation_ids: dict[tuple[int, int], UUID],
    machine_ids: list[UUID],
) -> tuple[int, int]:
    """Write the solved schedule, returning how many entries and dependencies were created.

    The schedule is stored as confirmed: seeded data exists to be simulated, and the simulation
    refuses anything else. Cost totals stay NULL because the instance carries no cost data.
    """

    schedule_id = uuid4()
    await _insert_all(
        session,
        Schedule,
        [
            {
                "id": schedule_id,
                "status": "confirmed",
                "strategy": solution.solver,
                "makespan": solution.makespan,
                "confirmed_at": datetime.now(UTC),
            }
        ],
    )

    # One entry per operation. The machine and duration are the instance's, not the solution's --
    # a solution only decides ordering.
    entry_ids: dict[tuple[int, int], UUID] = {}
    entry_rows: list[dict[str, Any]] = []
    for operation in instance.operations:
        entry_id = uuid4()
        entry_ids[(operation.job, operation.index)] = entry_id
        entry_rows.append(
            {
                "id": entry_id,
                "schedule_id": schedule_id,
                "operation_id": operation_ids[(operation.job, operation.index)],
                "machine_id": machine_ids[operation.machine],
                "duration": operation.duration,
            }
        )

    precedence_rows: list[dict[str, Any]] = []

    # job_order: the instance's own precedence chain, restated against this schedule's entries.
    for operations in instance.operations_by_job.values():
        for earlier, later in pairwise(operations):
            precedence_rows.append(
                {
                    "id": uuid4(),
                    "schedule_entry_id": entry_ids[(later.job, later.index)],
                    "depends_on_schedule_entry_id": entry_ids[(earlier.job, earlier.index)],
                    "reason": "job_order",
                }
            )

    # machine_queue: the ordering the solver actually chose. Each machine works through its jobs in
    # sequence, so every job waits for the one before it in that queue.
    operation_on_machine = {
        (operation.machine, operation.job): (operation.job, operation.index)
        for operation in instance.operations
    }
    for machine, sequence in sorted(solution.machine_sequences.items()):
        for earlier_job, later_job in pairwise(sequence):
            precedence_rows.append(
                {
                    "id": uuid4(),
                    "schedule_entry_id": entry_ids[operation_on_machine[(machine, later_job)]],
                    "depends_on_schedule_entry_id": entry_ids[
                        operation_on_machine[(machine, earlier_job)]
                    ],
                    "reason": "machine_queue",
                }
            )
    await _insert_all(session, ScheduleEntry, entry_rows)

    await _insert_all(session, ScheduleDependency, precedence_rows)
    return len(entry_rows), len(precedence_rows)


async def clear_scheduling_data(session: AsyncSession) -> int:
    """Remove every scenario row, returning how many operator logins had to go with them.

    Manager logins survive -- they are not scenario data. Operator logins are: each one is tied to a
    single machine, and the machine is about to be deleted.
    """

    for model in _CLEAR_ORDER:
        await session.execute(delete(model))

    operator_ids = list(
        (await session.execute(select(User.id).where(User.role == "operator"))).scalars()
    )
    if operator_ids:
        await session.execute(
            delete(UserCredential).where(UserCredential.user_id.in_(operator_ids))
        )
        await session.execute(delete(User).where(User.id.in_(operator_ids)))

    await session.execute(delete(Machine))
    await session.execute(delete(Category))

    return len(operator_ids)


async def _insert_all(session: AsyncSession, model: type[Any], rows: list[dict[str, Any]]) -> None:
    if rows:
        await session.execute(insert(model), rows)


def _index_width(count: int) -> int:
    """Digits needed for the largest index, so generated names sort correctly as text."""

    return len(str(max(count - 1, 0)))


async def seed_flexible_instance(
    session: AsyncSession,
    instance: FlexibleInstance,
    solution: BenchmarkSolution | None = None,
) -> SeedSummary:
    """Replace the current scenario with a flexible instance, and its schedule when supplied.

    Unlike a classic instance, an operation here has several compatible machines, so it writes
    several `compatibilities` rows -- and precedence comes from the file's own edges rather than
    from operation order, so a job can branch.
    """

    if solution is not None:
        validate_flexible_against(solution, instance)

    removed_logins = await clear_scheduling_data(session)

    # Job and machine labels are not necessarily contiguous, so map by label rather than index.
    machine_ids = {label: uuid4() for label in instance.machine_labels}
    job_ids = {label: uuid4() for label in instance.job_labels}
    machine_width = _label_width(instance.machine_labels)
    job_width = _label_width(instance.job_labels)
    operation_width = _label_width([operation.id for operation in instance.operations])

    await _insert_all(
        session,
        Machine,
        [
            {"id": machine_id, "name": f"{instance.name}/M{label:0{machine_width}d}"}
            for label, machine_id in machine_ids.items()
        ],
    )
    await _insert_all(
        session,
        Job,
        [{"id": job_id, "name": f"J{label:0{job_width}d}"} for label, job_id in job_ids.items()],
    )

    operation_ids = {operation.id: uuid4() for operation in instance.operations}
    # `position` is display order only, numbered from 1 per job in the file's own sequence. It is
    # not precedence: a flexible instance's edges can branch, and those are stored below as they
    # are, untouched by the order the builder happens to list the steps in.
    positions: dict[int, int] = {}
    next_position: dict[int, int] = {}
    for operation in instance.operations:
        positions[operation.id] = next_position.get(operation.job, 0) + 1
        next_position[operation.job] = positions[operation.id]
    await _insert_all(
        session,
        Operation,
        [
            {
                "id": operation_ids[operation.id],
                "job_id": job_ids[operation.job],
                "name": f"Op{operation.id:0{operation_width}d}",
                "position": positions[operation.id],
            }
            for operation in instance.operations
        ],
    )
    await _insert_all(
        session,
        Dependency,
        [
            {
                "id": uuid4(),
                "before_operation_id": operation_ids[before],
                "after_operation_id": operation_ids[after],
                "origin": "legacy",
            }
            for before, after in instance.dependencies
        ],
    )

    # The point of a flexible instance: one operation, several machines it could run on.
    compatibility_rows = [
        {
            "id": uuid4(),
            "operation_id": operation_ids[operation.id],
            "machine_id": machine_ids[candidate.machine],
            "duration": candidate.duration,
        }
        for operation in instance.operations
        for candidate in operation.candidates
    ]
    await _insert_all(session, Compatibility, compatibility_rows)

    entry_count = 0
    queue_count = 0
    if solution is not None:
        entry_count, queue_count = await _seed_flexible_schedule(
            session, instance, solution, operation_ids, machine_ids
        )

    return SeedSummary(
        instance=instance.name,
        family=instance.family,
        machines=len(machine_ids),
        jobs=len(job_ids),
        operations=len(operation_ids),
        dependencies=len(instance.dependencies),
        compatibilities=len(compatibility_rows),
        removed_operator_logins=removed_logins,
        solver=solution.solver if solution else None,
        makespan=solution.makespan if solution else None,
        schedule_entries=entry_count,
        schedule_dependencies=queue_count,
    )


async def _seed_flexible_schedule(
    session: AsyncSession,
    instance: FlexibleInstance,
    solution: BenchmarkSolution,
    operation_ids: dict[int, UUID],
    machine_ids: dict[int, UUID],
) -> tuple[int, int]:
    """Write a solved flexible schedule, returning entry and dependency counts.

    Which machine each operation runs on is the solver's choice here, recovered from whichever
    machine sequence the operation appears in.
    """

    schedule_id = uuid4()
    await _insert_all(
        session,
        Schedule,
        [
            {
                "id": schedule_id,
                "status": "confirmed",
                "strategy": solution.solver,
                "makespan": solution.makespan,
                "confirmed_at": datetime.now(UTC),
            }
        ],
    )

    by_id = instance.operations_by_id
    entry_ids: dict[int, UUID] = {}
    entry_rows: list[dict[str, Any]] = []
    for machine, sequence in sorted(solution.machine_sequences.items()):
        for operation_id in sequence:
            duration = next(
                candidate.duration
                for candidate in by_id[operation_id].candidates
                if candidate.machine == machine
            )
            entry_id = uuid4()
            entry_ids[operation_id] = entry_id
            entry_rows.append(
                {
                    "id": entry_id,
                    "schedule_id": schedule_id,
                    "operation_id": operation_ids[operation_id],
                    "machine_id": machine_ids[machine],
                    "duration": duration,
                }
            )
    await _insert_all(session, ScheduleEntry, entry_rows)

    recorded: set[tuple[int, int]] = set()
    precedence_rows: list[dict[str, Any]] = []
    for before, after in instance.dependencies:
        recorded.add((before, after))
        precedence_rows.append(
            {
                "id": uuid4(),
                "schedule_entry_id": entry_ids[after],
                "depends_on_schedule_entry_id": entry_ids[before],
                "reason": "job_order",
            }
        )

    # A flexible instance can put two operations of one job on the same machine, back to back, so a
    # pair can be both a job_order and a machine_queue wait. Only one row may exist per pair, and
    # job_order is the one to keep: it holds whatever machine the solver picked. A classic instance
    # cannot reach this case, since each of its jobs visits a machine only once.
    for sequence in solution.machine_sequences.values():
        for earlier, later in pairwise(sequence):
            if (earlier, later) in recorded:
                continue
            recorded.add((earlier, later))
            precedence_rows.append(
                {
                    "id": uuid4(),
                    "schedule_entry_id": entry_ids[later],
                    "depends_on_schedule_entry_id": entry_ids[earlier],
                    "reason": "machine_queue",
                }
            )

    await _insert_all(session, ScheduleDependency, precedence_rows)
    return len(entry_rows), len(precedence_rows)


def _label_width(labels: Sequence[int]) -> int:
    """Digits needed for the largest label, so generated names sort correctly as text."""

    return len(str(max(labels))) if labels else 1
