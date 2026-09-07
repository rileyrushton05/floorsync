"""allow machines and compatibilities without cost data

Machine salary, machine category and compatibility energy become nullable so a scenario can be
loaded from a source that does not record them -- an academic job-shop benchmark states durations
only. NULL means "not recorded by the source", not zero.

Schedule entries snapshot those same two costs at generation time, so they become nullable too:
otherwise generating a schedule from a benchmark scenario would fail on a NOT NULL it can never
satisfy. schedule_entries.duration stays required -- every source records it, and an entry without
one cannot be sequenced.

Revision ID: 20260906_0001
Revises: 20260904_0001
Create Date: 2026-09-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260906_0001"
down_revision: str | Sequence[str] | None = "20260904_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "compatibilities",
        "energy",
        existing_type=sa.NUMERIC(precision=10, scale=2),
        nullable=True,
    )
    op.alter_column(
        "machines",
        "category_id",
        existing_type=sa.UUID(),
        nullable=True,
    )
    op.alter_column(
        "machines",
        "salary",
        existing_type=sa.NUMERIC(precision=10, scale=2),
        nullable=True,
    )
    op.alter_column(
        "schedule_entries",
        "energy",
        existing_type=sa.NUMERIC(precision=10, scale=2),
        nullable=True,
    )
    op.alter_column(
        "schedule_entries",
        "machine_salary",
        existing_type=sa.NUMERIC(precision=10, scale=2),
        nullable=True,
    )


def downgrade() -> None:
    """Restore NOT NULL.

    This fails if any row holds a NULL in these columns -- a seeded benchmark scenario will. Clear
    the scenario data before downgrading.
    """

    op.alter_column(
        "schedule_entries",
        "machine_salary",
        existing_type=sa.NUMERIC(precision=10, scale=2),
        nullable=False,
    )
    op.alter_column(
        "schedule_entries",
        "energy",
        existing_type=sa.NUMERIC(precision=10, scale=2),
        nullable=False,
    )
    op.alter_column(
        "machines",
        "salary",
        existing_type=sa.NUMERIC(precision=10, scale=2),
        nullable=False,
    )
    op.alter_column(
        "machines",
        "category_id",
        existing_type=sa.UUID(),
        nullable=False,
    )
    op.alter_column(
        "compatibilities",
        "energy",
        existing_type=sa.NUMERIC(precision=10, scale=2),
        nullable=False,
    )
