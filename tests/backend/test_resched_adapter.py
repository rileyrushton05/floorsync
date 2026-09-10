import importlib.util
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import assert_never
from uuid import UUID

import pytest

from floorsync_common.scheduling import (
    DependencySpec,
    MachineSpec,
    OperationSpec,
    ReSchedEngine,
    ReSchedRuntimeUnavailable,
    RouteSpec,
    ScheduleGenerated,
    SchedulingInput,
    SchedulingInputInvalid,
    UnavailabilitySpec,
)


def uid(value: int) -> UUID:
    return UUID(int=value)


def test_resched_rejects_floor_sync_features_it_cannot_represent() -> None:
    problem = SchedulingInput(
        starts_at=datetime(2026, 9, 7, 8, tzinfo=UTC),
        machines=(MachineSpec(id=uid(1), active=True, salary_per_minute=Decimal("1.00")),),
        operations=(OperationSpec(id=uid(11), name="Cut"),),
        routes=(RouteSpec(uid(11), uid(1), 10, Decimal("2.00")),),
        dependencies=(),
        unavailabilities=(
            # Any valid downtime interval is unsupported by ReSched's standard FJSP environment.
            UnavailabilitySpec(
                uid(1),
                datetime(2026, 9, 7, 9, tzinfo=UTC),
                datetime(2026, 9, 7, 10, tzinfo=UTC),
            ),
        ),
    )

    result = ReSchedEngine.generate(problem)

    match result:
        case SchedulingInputInvalid(issues=issues):
            assert [issue.code for issue in issues] == ["unsupported_unavailability"]
        case ScheduleGenerated() | ReSchedRuntimeUnavailable():
            raise AssertionError("downtime must be rejected before ReSched inference")
        case _:
            assert_never(result)


def test_resched_pretrained_policy_produces_a_feasible_floor_sync_plan() -> None:
    if importlib.util.find_spec("numpy") is None or importlib.util.find_spec("torch") is None:
        pytest.skip("ReSched optional runtime is not installed")
    if not Path("src/backend/third_party/ReSched").is_dir():
        pytest.skip("ReSched submodule is not initialised")
    problem = SchedulingInput(
        starts_at=datetime(2026, 9, 7, 8, tzinfo=UTC),
        machines=(
            MachineSpec(id=uid(1), active=True, salary_per_minute=Decimal("1.00")),
            MachineSpec(id=uid(2), active=True, salary_per_minute=Decimal("1.50")),
        ),
        operations=(
            OperationSpec(id=uid(11), name="Cut"),
            OperationSpec(id=uid(12), name="Polish"),
        ),
        routes=(
            RouteSpec(uid(11), uid(1), 10, Decimal("2.00")),
            RouteSpec(uid(11), uid(2), 12, Decimal("2.00")),
            RouteSpec(uid(12), uid(1), 8, Decimal("2.00")),
            RouteSpec(uid(12), uid(2), 6, Decimal("2.00")),
        ),
        dependencies=(DependencySpec(uid(11), uid(12)),),
    )

    result = ReSchedEngine.generate(problem)

    match result:
        case ScheduleGenerated(plan=plan):
            assignments = {assignment.operation_id: assignment for assignment in plan.assignments}
            assert len(assignments) == 2
            assert assignments[uid(12)].starts_at >= assignments[uid(11)].ends_at
        case SchedulingInputInvalid(issues=issues):
            raise AssertionError(issues)
        case ReSchedRuntimeUnavailable(detail=detail):
            raise AssertionError(detail)
        case _:
            assert_never(result)
