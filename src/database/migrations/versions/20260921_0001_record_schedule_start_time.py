"""record each schedule's manager-selected start time

Revision ID: 20260921_0001
Revises: 20260916_0002
Create Date: 2026-09-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260921_0001"
down_revision: str | Sequence[str] | None = "20260916_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("schedules", sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True))
    # Existing rows have no requested start persisted. Their first assigned operation is the
    # closest faithful reconstruction; pre-timing rows fall back to their creation time.
    op.execute(
        """
        UPDATE schedules
        SET starts_at = COALESCE(
            (
                SELECT MIN(schedule_entries.start_time)
                FROM schedule_entries
                WHERE schedule_entries.schedule_id = schedules.id
            ),
            schedules.created_at
        )
        """
    )
    op.alter_column(
        "schedules", "starts_at", existing_type=sa.DateTime(timezone=True), nullable=False
    )
    op.create_index(op.f("ix_schedules_starts_at"), "schedules", ["starts_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_schedules_starts_at"), table_name="schedules")
    op.drop_column("schedules", "starts_at")
