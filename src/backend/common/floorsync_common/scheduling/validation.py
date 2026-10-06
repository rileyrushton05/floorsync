"""Read the floor as generation would and report what is wrong with it (#133).

The checks themselves are pure and live in `input_checks`; this module is the one place that knows
the database. It loads the same snapshot a generation run would, through `SchedulingService`, runs
the shared checks on it, and adds the two facts the snapshot cannot show.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import assert_never
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.scheduling.contracts import (
    SchedulingInput,
    SchedulingInputInvalid,
    SchedulingIssue,
)
from floorsync_common.scheduling.input_checks import (
    STRATEGIES,
    StrategyName,
    strategy_limits,
    validate_input,
)
from floorsync_common.scheduling.service import LoadInputResult, SchedulingService

JOB_HAS_NO_OPERATIONS = "job_has_no_operations"
"""An open job holds no operation, so a whole-floor run silently leaves it unplanned."""

MACHINE_HAS_NO_CAPABILITIES = "machine_has_no_capabilities"
"""An active machine no operation can run on, so no schedule will ever use it."""


@dataclass(frozen=True, slots=True)
class StrategyLimit:
    """One thing a named strategy cannot take, on otherwise coherent data."""

    strategy: StrategyName
    issue: SchedulingIssue


@dataclass(frozen=True, slots=True)
class FloorValidation:
    """Everything a manager should know before asking for a schedule.

    `issues` are data problems that stop every strategy. `warnings` are things worth knowing that
    stop nothing. `unsupported` lists, per strategy, what coherent data that strategy still cannot
    take. `schedulable` answers the question the scheduler page asks: could I press Generate with
    this strategy right now?
    """

    issues: tuple[SchedulingIssue, ...]
    warnings: tuple[SchedulingIssue, ...]
    unsupported: tuple[StrategyLimit, ...]
    schedulable: Mapping[StrategyName, bool]


class ValidationService:
    """Read the floor as generation would and report what is wrong with it. Stateless."""

    @staticmethod
    async def validate_floor(db: AsyncSession, *, job_ids: Collection[UUID]) -> FloorValidation:
        """Validate the given selection without generating anything.

        Loads through `SchedulingService.load_input` so the snapshot is exactly what a generation
        run would see, selection refusals included: those come back as issues too, since a manager
        who ticked an unknown, archived or already run job wants to hear it here rather than
        after queueing a run. `starts_at` is now, because nothing here depends on the start beyond
        it having a timezone.
        """

        selection = frozenset(job_ids)

        def load(session: Session) -> LoadInputResult:
            return SchedulingService.load_input(
                session, starts_at=datetime.now(UTC), job_ids=selection
            )

        loaded = await db.run_sync(load)
        warnings = await ValidationService._warnings(db, selection)

        match loaded:
            case SchedulingInputInvalid(issues=issues):
                return FloorValidation(
                    issues=issues,
                    warnings=warnings,
                    unsupported=(),
                    schedulable={strategy: False for strategy in STRATEGIES},
                )
            case SchedulingInput() as problem:
                pass
            case _:
                assert_never(loaded)

        issues = validate_input(problem)
        limits = strategy_limits(problem)
        unsupported = tuple(
            StrategyLimit(strategy=strategy, issue=issue)
            for strategy in STRATEGIES
            for issue in limits[strategy]
        )
        return FloorValidation(
            issues=issues,
            warnings=warnings,
            unsupported=unsupported,
            schedulable={strategy: not issues and not limits[strategy] for strategy in STRATEGIES},
        )

    @staticmethod
    async def _warnings(
        db: AsyncSession, selection: frozenset[UUID]
    ) -> tuple[SchedulingIssue, ...]:
        """The two facts the snapshot cannot show, because the rows in question leave no trace.

        A selected job with no operations contributes nothing to the input, so a run plans around
        it without a word; an active machine nothing can run on is never chosen. Neither blocks a
        schedule, both are probably mistakes.
        """

        empty_jobs = (
            select(Job.id)
            .outerjoin(Operation, Operation.job_id == Job.id)
            .where(Operation.id.is_(None), Job.id.in_(selection))
            .order_by(Job.id)
        )
        idle_machines = (
            select(Machine.id)
            .outerjoin(Compatibility, Compatibility.machine_id == Machine.id)
            .where(Compatibility.id.is_(None), Machine.active.is_(True))
            .order_by(Machine.id)
        )

        warnings = [
            SchedulingIssue(
                JOB_HAS_NO_OPERATIONS,
                "This job has no operations, so a schedule would not include it.",
                job_id=job_id,
            )
            for job_id in (await db.scalars(empty_jobs)).all()
        ]
        warnings.extend(
            SchedulingIssue(
                MACHINE_HAS_NO_CAPABILITIES,
                "No operation can run on this machine, so no schedule will use it.",
                machine_id=machine_id,
            )
            for machine_id in (await db.scalars(idle_machines)).all()
        )
        return tuple(warnings)


__all__ = [
    "JOB_HAS_NO_OPERATIONS",
    "MACHINE_HAS_NO_CAPABILITIES",
    "FloorValidation",
    "StrategyLimit",
    "ValidationService",
]
