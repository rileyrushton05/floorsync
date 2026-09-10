"""store schedule run metrics

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


def downgrade() -> None:
    op.drop_column("schedules", "input_operation_count")
    op.drop_column("schedules", "runtime_ms")
