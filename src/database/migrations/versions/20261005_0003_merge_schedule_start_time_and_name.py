"""join the schedule start-time and schedule-name branches

`20260921_0001` (record a schedule's start time) and `20261005_0001` (name a schedule) were both
written on top of `20260916_0002` on separate feature branches. This revision only rejoins the two
lines so `alembic upgrade head` has a single head again; a database on either branch picks up the
migrations it is missing.

Revision ID: 20261005_0003
Revises: 20260921_0001, 20261005_0002
Create Date: 2026-10-05
"""

from collections.abc import Sequence

revision: str = "20261005_0003"
down_revision: str | Sequence[str] | None = ("20260921_0001", "20261005_0002")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
