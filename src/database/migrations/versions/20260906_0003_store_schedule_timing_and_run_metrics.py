"""store schedule timing and run metrics

Revision ID: 20260906_0003
Revises: 20260906_0002
Create Date: 2026-09-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260906_0003"
down_revision: str | Sequence[str] | None = "20260906_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("schedules", sa.Column("runtime_ms", sa.Integer(), nullable=True))
    op.add_column("schedules", sa.Column("input_operation_count", sa.Integer(), nullable=True))

    op.add_column(
        "schedule_entries",
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "schedule_entries",
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Existing development rows predate calendar-aware planning. Give them a valid, deterministic
    # legacy timeline before making the new invariant mandatory; newly generated rows supply their
    # real planned timestamps.
    op.execute(
        """
        UPDATE schedule_entries AS entry
        SET starts_at = schedule.created_at,
            ends_at = schedule.created_at + entry.duration * INTERVAL '1 minute'
        FROM schedules AS schedule
        WHERE entry.schedule_id = schedule.id
        """
    )
    op.alter_column("schedule_entries", "starts_at", nullable=False)
    op.alter_column("schedule_entries", "ends_at", nullable=False)
    op.create_check_constraint(
        "ends_after_starts",
        "schedule_entries",
        "ends_at > starts_at",
    )


def downgrade() -> None:
    # The original revision used the fully-expanded name with a naming
    # convention, which created a duplicated prefix.  Accept that already
    # applied name as well as the corrected name when rolling back.
    op.execute(
        "ALTER TABLE schedule_entries "
        "DROP CONSTRAINT IF EXISTS ck_schedule_entries_ends_after_starts"
    )
    op.execute(
        "ALTER TABLE schedule_entries "
        "DROP CONSTRAINT IF EXISTS ck_schedule_entries_ck_schedule_entries_ends_after_starts"
    )
    op.drop_column("schedule_entries", "ends_at")
    op.drop_column("schedule_entries", "starts_at")
    op.drop_column("schedules", "input_operation_count")
    op.drop_column("schedules", "runtime_ms")
