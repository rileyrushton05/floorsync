"""drop the redundant unique constraint on user_credentials.user_id

`UserCredential.user_id` is declared `unique=True, index=True`, which SQLAlchemy expresses as a
single unique index. The hand-written authentication migration additionally created a
`UniqueConstraint`, so the table ended up with two identical unique btree indexes on the same
column: `ix_user_credentials_user_id` and `uq_user_credentials_user_id`.

The duplicate costs a second index write on every insert and made `alembic check` fail for everyone,
because the model only ever described one of them. `users.machine_id` uses the same column pattern
and correctly has the index alone, which is the shape being restored here.

The original migration is left untouched: it has already been applied, so correcting it in place
would leave existing databases holding a constraint that a freshly built one never creates.

Revision ID: 20260906_0002
Revises: 20260906_0001
Create Date: 2026-09-06
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260906_0002"
down_revision: str | Sequence[str] | None = "20260906_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f("uq_user_credentials_user_id"), "user_credentials", type_="unique")


def downgrade() -> None:
    op.create_unique_constraint(
        op.f("uq_user_credentials_user_id"), "user_credentials", ["user_id"]
    )
