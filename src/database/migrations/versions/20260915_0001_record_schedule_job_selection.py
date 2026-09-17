"""record which jobs a schedule was asked to plan

A schedule generated for a chosen subset of the backlog (#231) has nowhere to say what that subset
was. `schedule_entries` records which operations were *placed*, which is not the same question: a
selected job holding no schedulable work leaves no entry behind, and no amount of reading the
entries back explains why the floor's other jobs are absent.

No rows for a schedule means it was generated for the whole floor. That is true of every schedule
made before this table existed and of every unscoped run after it, and it never collides with a
scoped run, which always names at least one job because an empty selection is refused before
generation starts.

Revision ID: 20260915_0001
Revises: 20260914_0001
Create Date: 2026-09-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260915_0001"
down_revision: str | Sequence[str] | None = "20260914_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "schedule_job_selections",
        sa.Column(
            "id",
            sa.Uuid(),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("schedule_id", sa.Uuid(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_schedule_job_selections")),
        sa.ForeignKeyConstraint(
            ["schedule_id"],
            ["schedules.id"],
            name=op.f("fk_schedule_job_selections_schedule_id_schedules"),
            ondelete="CASCADE",
        ),
        # RESTRICT, matching `schedule_entries.operation_id`: a schedule is a record of a decision,
        # and deleting a job it names would quietly rewrite that record.
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["jobs.id"],
            name=op.f("fk_schedule_job_selections_job_id_jobs"),
            ondelete="RESTRICT",
        ),
        # A schedule names a job at most once. A constraint rather than an application pre-check,
        # so it holds under two writers racing for the same pair.
        sa.UniqueConstraint(
            "schedule_id", "job_id", name=op.f("uq_schedule_job_selections_schedule_id")
        ),
    )
    # Both foreign keys are join and deletion paths: "what was this schedule asked to plan" reads by
    # schedule_id, and the RESTRICT on job deletion has to look up by job_id. PostgreSQL does not
    # index the referencing side of a foreign key on its own.
    op.create_index(
        op.f("ix_schedule_job_selections_schedule_id"),
        "schedule_job_selections",
        ["schedule_id"],
    )
    op.create_index(
        op.f("ix_schedule_job_selections_job_id"), "schedule_job_selections", ["job_id"]
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_schedule_job_selections_job_id"), table_name="schedule_job_selections")
    op.drop_index(
        op.f("ix_schedule_job_selections_schedule_id"), table_name="schedule_job_selections"
    )
    op.drop_table("schedule_job_selections")
