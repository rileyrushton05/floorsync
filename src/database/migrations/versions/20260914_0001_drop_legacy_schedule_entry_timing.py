"""drop legacy schedule entry timing columns

Revision ID: 20260914_0001
Revises: 20260913_0001
Create Date: 2026-09-14

An earlier version of 20260906_0003 added non-null schedule_entries.starts_at/ends_at. That
migration file was later rewritten under the same revision id (see 8769e53), so Alembic has never
recorded starts_at/ends_at as existing -- but a database that ran the original version before the
rewrite landed still has them, NOT NULL, unknown to every migration since. 20260910_0001 then added
the nullable start_time column the ORM model actually uses, without reconciling the two.

The result: inserting a schedule_entries row on such a database fails the starts_at/ends_at NOT NULL
constraint, because current code has never heard of those columns. See issue #251.

This migration is written to run cleanly whether or not the legacy columns are present, so it is
correct both on a database that took the original 20260906_0003 and on one that only ever saw the
rewritten version (or a fresh database that never ran either migration and has neither column at
all).
"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "20260914_0001"
down_revision: str | Sequence[str] | None = "20260913_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LEGACY_COLUMN = "starts_at"


def upgrade() -> None:
    # A fresh database, or one that only ever ran the rewritten 20260906_0003, has no starts_at
    # column at all -- nothing to backfill from, nothing to drop.
    conn = op.get_bind()
    has_legacy_column = conn.execute(
        text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'schedule_entries' AND column_name = :column"
        ),
        {"column": _LEGACY_COLUMN},
    ).first()
    if has_legacy_column is None:
        return

    op.execute(
        """
        UPDATE schedule_entries
        SET start_time = starts_at
        WHERE start_time IS NULL
        """
    )
    op.execute(
        "ALTER TABLE schedule_entries "
        "DROP CONSTRAINT IF EXISTS ck_schedule_entries_ends_after_starts"
    )
    op.execute("ALTER TABLE schedule_entries DROP COLUMN IF EXISTS ends_at")
    op.execute("ALTER TABLE schedule_entries DROP COLUMN IF EXISTS starts_at")


def downgrade() -> None:
    # The legacy columns were schema drift, not a real feature -- there is nothing to restore them
    # to. A downgrade only needs to undo what upgrade() itself did, and upgrade() never invents data
    # beyond copying starts_at into start_time, so leave start_time as is.
    pass
