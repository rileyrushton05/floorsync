"""let a job leave the backlog without being deleted

A job a confirmed schedule has planned cannot be deleted: `schedule_entries.operation_id` restricts
it, because the schedule is the record of what the floor was told to do. Until now that left no way
to retire a finished or cancelled job, so every job stayed in the backlog forever and was offered
to every later generation.

`archived_at` is that way out. NULL means the job is open; a timestamp means it left the backlog
then, either by hand or because a simulation of a schedule containing it completed. Listing and
unscoped generation skip archived jobs; history keeps pointing at them (decision 0015).

Revision ID: 20260916_0001
Revises: 20260915_0001
Create Date: 2026-09-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260916_0001"
down_revision: str | Sequence[str] | None = "20260915_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f("ix_jobs_archived_at"), "jobs", ["archived_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_jobs_archived_at"), table_name="jobs")
    op.drop_column("jobs", "archived_at")
