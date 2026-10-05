"""let a manager scrub a simulation

A `seeked` control moves the play head to a chosen simulated time without changing whether playback
is running, so the event log carries the position it jumped to. Only a seek may carry one, and the
event-type check gains the new value.

Revision ID: 20261005_0002
Revises: 20261005_0001
Create Date: 2026-10-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20261005_0002"
down_revision: str | Sequence[str] | None = "20261005_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PREVIOUS_TYPES = "'started', 'paused', 'resumed', 'speed_changed', 'reset', 'completed'"


def upgrade() -> None:
    op.add_column("simulation_events", sa.Column("position", sa.Double(), nullable=True))
    op.drop_constraint(
        op.f("ck_simulation_events_event_type_valid"), "simulation_events", type_="check"
    )
    op.create_check_constraint(
        op.f("ck_simulation_events_event_type_valid"),
        "simulation_events",
        f"event_type IN ({_PREVIOUS_TYPES}, 'seeked')",
    )
    op.create_check_constraint(
        op.f("ck_simulation_events_position_only_on_seek"),
        "simulation_events",
        "(event_type = 'seeked') = (position IS NOT NULL) AND (position IS NULL OR position >= 0)",
    )


def downgrade() -> None:
    op.execute("DELETE FROM simulation_events WHERE event_type = 'seeked'")
    op.drop_constraint(
        op.f("ck_simulation_events_position_only_on_seek"), "simulation_events", type_="check"
    )
    op.drop_constraint(
        op.f("ck_simulation_events_event_type_valid"), "simulation_events", type_="check"
    )
    op.create_check_constraint(
        op.f("ck_simulation_events_event_type_valid"),
        "simulation_events",
        f"event_type IN ({_PREVIOUS_TYPES})",
    )
    op.drop_column("simulation_events", "position")
