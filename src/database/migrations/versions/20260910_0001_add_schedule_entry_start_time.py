"""add schedule entry start time

Revision ID: 20260910_0001
Revises: 20260906_0003
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260910_0001"
down_revision: str | Sequence[str] | None = "20260906_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable: existing rows predate this column and have no start time to backfill without
    # re-deriving it from schedule_dependencies, which is exactly what this column replaces. New
    # schedules always populate it (SchedulingService.store_draft); a schedule generated before
    # this migration needs regenerating before it can be simulated.
    op.add_column(
        "schedule_entries", sa.Column("start_time", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("schedule_entries", "start_time")
