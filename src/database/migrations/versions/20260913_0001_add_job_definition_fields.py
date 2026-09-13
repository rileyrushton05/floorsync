"""add job definition fields

The manager job builder edits three things the schema could not hold: a job's priority, a stable
display order for its operations, and -- so a builder save can rewrite its own ordering edges
without destroying imported ones -- which rows in `dependencies` the builder owns.

Each column is added nullable, backfilled, then tightened, so the migration is safe on a database
that already holds rows. No job-level dependency is added: jobs are independent by design, and
precedence only ever joins operations.

Revision ID: 20260913_0001
Revises: 20260910_0001
Create Date: 2026-09-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260913_0001"
down_revision: str | Sequence[str] | None = "20260910_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # jobs.priority -- every existing job becomes 'med', and the server default stays so a row
    # inserted without stating a priority (the seed loader, a raw INSERT) still has a valid one.
    op.add_column(
        "jobs",
        sa.Column("priority", sa.Text(), nullable=False, server_default="med"),
    )
    op.create_check_constraint(
        op.f("ck_jobs_priority_valid"), "jobs", "priority IN ('high', 'med', 'low')"
    )

    # operations.position -- numbered 1..N within each job, in the order the rows were created,
    # with id as the tie-breaker so two operations created in the same instant get a stable order.
    op.add_column("operations", sa.Column("position", sa.Integer(), nullable=True))
    op.execute(
        """
        UPDATE operations
        SET position = numbered.position
        FROM (
            SELECT id, row_number() OVER (PARTITION BY job_id ORDER BY created_at, id) AS position
            FROM operations
        ) AS numbered
        WHERE operations.id = numbered.id
        """
    )
    op.alter_column("operations", "position", existing_type=sa.Integer(), nullable=False)
    op.create_check_constraint(
        op.f("ck_operations_position_positive"), "operations", "position >= 1"
    )
    # Deferred to commit: a reorder swaps values between rows, and checked immediately the first
    # update would collide with a value the second row has not given up yet.
    op.create_unique_constraint(
        op.f("uq_operations_job_id"),
        "operations",
        ["job_id", "position"],
        deferrable=True,
        initially="DEFERRED",
    )

    # dependencies.origin -- every edge that exists today predates the builder, so none is its to
    # rewrite. The server default keeps that true for any writer that does not say otherwise.
    op.add_column(
        "dependencies",
        sa.Column("origin", sa.Text(), nullable=False, server_default="legacy"),
    )
    op.create_check_constraint(
        op.f("ck_dependencies_origin_valid"),
        "dependencies",
        "origin IN ('legacy', 'builder_sequence')",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_dependencies_origin_valid"), "dependencies", type_="check")
    op.drop_column("dependencies", "origin")

    op.drop_constraint(op.f("uq_operations_job_id"), "operations", type_="unique")
    op.drop_constraint(op.f("ck_operations_position_positive"), "operations", type_="check")
    op.drop_column("operations", "position")

    op.drop_constraint(op.f("ck_jobs_priority_valid"), "jobs", type_="check")
    op.drop_column("jobs", "priority")
