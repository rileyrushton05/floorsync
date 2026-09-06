"""Write a parsed benchmark instance into the database, replacing whatever was there before.

Only one scenario is loaded at a time: seeding clears the scheduling core first, so the database
always reflects exactly one instance rather than an accumulation of several.
"""

from __future__ import annotations

from dataclasses import dataclass
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
from floorsync_common.seed.instances import BenchmarkInstance

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


async def seed_instance(session: AsyncSession, instance: BenchmarkInstance) -> SeedSummary:
    """Replace the current scenario with `instance`.

    The caller owns the transaction, so a failure part-way leaves the database untouched rather than
    half-seeded.
    """

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
        [
            {"id": job_id, "name": f"{instance.name}/J{index:0{job_width}d}"}
            for index, job_id in enumerate(job_ids)
        ],
    )

    operation_rows: list[dict[str, Any]] = []
    dependency_rows: list[dict[str, Any]] = []
    compatibility_rows: list[dict[str, Any]] = []

    for job, operations in instance.operations_by_job.items():
        operation_width = _index_width(len(operations))
        previous_id: UUID | None = None
        for operation in operations:
            operation_id = uuid4()
            operation_rows.append(
                {
                    "id": operation_id,
                    "job_id": job_ids[job],
                    "name": f"Op{operation.index:0{operation_width}d}",
                }
            )
            # The file states precedence only as operation order within a job, so each step depends
            # on the one before it -- a simple chain, not the fan-in the schema also supports.
            if previous_id is not None:
                dependency_rows.append(
                    {
                        "id": uuid4(),
                        "before_operation_id": previous_id,
                        "after_operation_id": operation_id,
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

    return SeedSummary(
        instance=instance.name,
        family=instance.family,
        machines=len(machine_ids),
        jobs=len(job_ids),
        operations=len(operation_rows),
        dependencies=len(dependency_rows),
        compatibilities=len(compatibility_rows),
        removed_operator_logins=removed_logins,
    )


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
