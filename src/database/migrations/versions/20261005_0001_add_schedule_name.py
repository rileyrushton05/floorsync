"""let a manager name a schedule

Generation writes an unnamed draft; the Planner asks for a name when the manager saves it, so the
Schedules and Simulation pages can list runs by something more readable than a UUID. Nullable:
existing schedules, and drafts nobody has saved yet, have no name.

Revision ID: 20261005_0001
Revises: 20260921_0001
Create Date: 2026-10-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20261005_0001"
down_revision: str | Sequence[str] | None = "20260921_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("schedules", sa.Column("name", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("schedules", "name")
