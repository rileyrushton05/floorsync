"""let two operators trade machines

A manager can reassign an operator to a machine that already has one, which swaps the two operators'
machines. `users.machine_id` was unique through a plain unique index, and PostgreSQL checks a
non-deferrable unique index row by row, so even a single `UPDATE` that swaps both rows trips over
its own intermediate state. Setting either row to NULL in between is not an option either: the
`operator_role_matches_machine` check requires every operator to hold a machine at all times.

The index becomes a `DEFERRABLE INITIALLY IMMEDIATE` unique constraint. Ordinary writes are still
checked at the end of each statement, so a duplicate fails exactly where it did before; only a
statement that touches both rows at once gets to pass through the momentary overlap.

Revision ID: 20261008_0001
Revises: 20261005_0002
Create Date: 2026-10-08
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20261008_0001"
down_revision: str | Sequence[str] | None = "20261005_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index(op.f("ix_users_machine_id"), table_name="users")
    op.create_unique_constraint(
        op.f("uq_users_machine_id"),
        "users",
        ["machine_id"],
        deferrable=True,
        initially="IMMEDIATE",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("uq_users_machine_id"), "users", type_="unique")
    op.create_index(op.f("ix_users_machine_id"), "users", ["machine_id"], unique=True)
