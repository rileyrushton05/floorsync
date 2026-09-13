"""Model, migration and seed-loader coverage for jobs.priority, operations.position and
dependencies.origin (#234).

The route tests stub the service, and this repository has no real-database test fixture, so what
can be asserted here is the shape the migration and the models agree on, and that the seed loader
now writes rows that shape accepts. The migration's upgrade and downgrade were run against an empty
and a seeded database by hand; see the pull request.
"""

import asyncio
import importlib.util
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest
from sqlalchemy import CheckConstraint, UniqueConstraint, inspect
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.base import Base
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.seed import loader
from floorsync_common.seed.flexible import load_flexible_instance
from floorsync_common.seed.instances import load_instance

MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "src/database/migrations/versions/20260913_0001_add_job_definition_fields.py"
)


def _check_constraints(model: type[Base]) -> dict[str, str]:
    table = inspect(model).local_table
    return {
        str(constraint.name): str(constraint.sqltext)
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint)
    }


def test_job_priority_is_a_checked_text_column_with_a_default() -> None:
    column = inspect(Job).columns.priority

    assert not column.nullable
    assert column.server_default is not None
    assert column.server_default.arg == "med"
    assert "priority IN ('high', 'med', 'low')" in _check_constraints(Job).values()


def test_operation_position_is_positive_and_unique_within_a_job() -> None:
    column = inspect(Operation).columns.position
    table = inspect(Operation).local_table

    assert not column.nullable
    assert "position >= 1" in _check_constraints(Operation).values()

    unique = [c for c in table.constraints if isinstance(c, UniqueConstraint)]
    assert len(unique) == 1
    assert [column.name for column in unique[0].columns] == ["job_id", "position"]


def test_operation_position_uniqueness_is_deferred_to_commit() -> None:
    """A reorder swaps values between rows; checked immediately, the first update would collide."""

    table = inspect(Operation).local_table
    (unique,) = [c for c in table.constraints if isinstance(c, UniqueConstraint)]

    assert unique.deferrable is True
    assert unique.initially == "DEFERRED"


def test_dependency_origin_is_limited_to_external_and_builder_sequence() -> None:
    column = inspect(Dependency).columns.origin

    assert not column.nullable
    assert column.server_default is not None
    assert column.server_default.arg == "external"
    assert "origin IN ('external', 'builder_sequence')" in _check_constraints(Dependency).values()


def test_jobs_are_independent_at_the_schema_level() -> None:
    """No job-level dependency: no such table, and no column on `jobs` that points at another job.

    Precedence is an operation-level fact on `dependencies`; that is the only place it may live.
    """

    assert "job_dependencies" not in Base.metadata.tables

    job_columns = {column.name for column in inspect(Job).columns}
    assert not any("depend" in name for name in job_columns)

    foreign_keys = {fk.column.table.name for fk in inspect(Job).local_table.foreign_keys}
    assert "jobs" not in foreign_keys


def test_migration_extends_the_chain_with_matching_upgrade_and_downgrade() -> None:
    """The revision sits on the previous head, and downgrade removes exactly what upgrade adds."""

    spec = importlib.util.spec_from_file_location("migration_under_test", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.revision == "20260913_0001"
    assert module.down_revision == "20260910_0001"

    source = MIGRATION.read_text()
    upgrade_source, downgrade_source = source.split("def downgrade()")
    for column in ("priority", "position", "origin"):
        assert f'"{column}"' in upgrade_source
        assert f'"{column}"' in downgrade_source
    for constraint in (
        "ck_jobs_priority_valid",
        "ck_operations_position_positive",
        "uq_operations_job_id",
        "ck_dependencies_origin_valid",
    ):
        assert constraint in upgrade_source
        assert constraint in downgrade_source


def test_migration_adds_position_nullable_then_backfills_then_tightens() -> None:
    """The order the ticket specifies, so the migration is safe on a database that has rows."""

    source = MIGRATION.read_text()
    add = source.index('sa.Column("position", sa.Integer(), nullable=True)')
    backfill = source.index("row_number() OVER (PARTITION BY job_id ORDER BY created_at, id)")
    tighten = source.index('op.alter_column("operations", "position"')

    assert add < backfill < tighten


class RecordingSession:
    """Stands in for the database: the loader's only writes go through `_insert_all`."""

    def __init__(self) -> None:
        self.rows: dict[str, list[dict[str, Any]]] = {}


def _capture(monkeypatch: pytest.MonkeyPatch, session: RecordingSession) -> None:
    async def clear(_: AsyncSession) -> int:
        return 0

    async def insert_all(_: AsyncSession, model: type[Any], rows: list[dict[str, Any]]) -> None:
        session.rows.setdefault(model.__tablename__, []).extend(rows)

    monkeypatch.setattr(loader, "clear_scheduling_data", clear)
    monkeypatch.setattr(loader, "_insert_all", insert_all)


def _positions_by_job(rows: list[dict[str, Any]]) -> dict[Any, list[int]]:
    grouped: dict[Any, list[int]] = {}
    for row in rows:
        grouped.setdefault(row["job_id"], []).append(row["position"])
    return grouped


@pytest.mark.parametrize(
    ("seed", "name"),
    [
        (lambda s, n: loader.seed_instance(s, load_instance(n)), "abz5"),
        (lambda s, n: loader.seed_flexible_instance(s, load_flexible_instance(n)), "dafjs01"),
    ],
    ids=["classic", "flexible"],
)
def test_seed_loader_numbers_each_jobs_operations_from_one(
    monkeypatch: pytest.MonkeyPatch,
    seed: Callable[[AsyncSession, str], Any],
    name: str,
) -> None:
    """Every job's steps get positions 1..N in file order, whatever shape its precedence has."""

    session = RecordingSession()
    _capture(monkeypatch, session)

    asyncio.run(seed(cast(AsyncSession, session), name))

    for positions in _positions_by_job(session.rows["operations"]).values():
        assert positions == list(range(1, len(positions) + 1))


@pytest.mark.parametrize(
    ("seed", "name"),
    [
        (lambda s, n: loader.seed_instance(s, load_instance(n)), "abz5"),
        (lambda s, n: loader.seed_flexible_instance(s, load_flexible_instance(n)), "dafjs01"),
    ],
    ids=["classic", "flexible"],
)
def test_seed_loader_marks_imported_edges_as_external(
    monkeypatch: pytest.MonkeyPatch,
    seed: Callable[[AsyncSession, str], Any],
    name: str,
) -> None:
    """An imported edge is never the builder's to rewrite, so it must not look like one."""

    session = RecordingSession()
    _capture(monkeypatch, session)

    asyncio.run(seed(cast(AsyncSession, session), name))

    origins = {row["origin"] for row in session.rows["dependencies"]}
    assert origins == {"external"}


def test_seed_loader_keeps_fan_in_precedence_independent_of_position(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """dafjs01 has steps waiting on several others.

    Position is display order and must not flatten that: the edges stored are the file's own, and
    there are more of them than a chain would have.
    """

    session = RecordingSession()
    _capture(monkeypatch, session)

    asyncio.run(
        loader.seed_flexible_instance(
            cast(AsyncSession, session), load_flexible_instance("dafjs01")
        )
    )

    incoming: dict[Any, int] = {}
    for row in session.rows["dependencies"]:
        incoming[row["after_operation_id"]] = incoming.get(row["after_operation_id"], 0) + 1
    assert any(count > 1 for count in incoming.values())
