"""record each simulation change as a notification owed to the live dashboards

A manager's control is committed to `simulation_events`, then every open dashboard needs to hear
about it. Redis pub/sub carries that quickly but not reliably, so the change and a row here commit
together and a relay retries any row Redis never accepted. `simulations.live_sequence` numbers the
notifications per simulation so a client can order them and spot a gap (#148).

Revision ID: 20260916_0002
Revises: 20260916_0001
Create Date: 2026-09-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260916_0002"
down_revision: str | Sequence[str] | None = "20260916_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "simulations",
        sa.Column("live_sequence", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
    )
    op.create_table(
        "live_update_outbox",
        sa.Column("topic", sa.Text(), nullable=False),
        sa.Column("aggregate_id", sa.Uuid(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempt_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_error_code", sa.Text(), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
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
        sa.CheckConstraint(
            "attempt_count >= 0", name=op.f("ck_live_update_outbox_attempt_count_non_negative")
        ),
        sa.CheckConstraint("sequence > 0", name=op.f("ck_live_update_outbox_sequence_positive")),
        sa.CheckConstraint(
            "topic IN ('simulation.changed')", name=op.f("ck_live_update_outbox_topic_valid")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_live_update_outbox")),
        sa.UniqueConstraint(
            "aggregate_id", "sequence", name=op.f("uq_live_update_outbox_aggregate_id")
        ),
    )
    op.create_index(
        "ix_live_update_outbox_unpublished",
        "live_update_outbox",
        ["next_attempt_at", "created_at"],
        unique=False,
        postgresql_where=sa.text("published_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_live_update_outbox_unpublished",
        table_name="live_update_outbox",
        postgresql_where=sa.text("published_at IS NULL"),
    )
    op.drop_table("live_update_outbox")
    op.drop_column("simulations", "live_sequence")
