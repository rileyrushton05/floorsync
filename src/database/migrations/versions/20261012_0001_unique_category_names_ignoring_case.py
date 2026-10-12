"""make category names unique ignoring case

`uq_categories_name` let "Cutting" and "cutting" exist side by side. A unique index on
`lower(name)` refuses the second. Upgrading fails, naming the clashing value, if a database already
holds two names that differ only in case; rename one first. Downgrading always succeeds, since names
unique ignoring case are also unique exactly.

Revision ID: 20261012_0001
Revises: 20261005_0002
Create Date: 2026-10-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20261012_0001"
down_revision: str | Sequence[str] | None = "20261005_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("uq_categories_lower_name", "categories", [sa.text("lower(name)")], unique=True)
    op.drop_constraint(op.f("uq_categories_name"), "categories", type_="unique")


def downgrade() -> None:
    op.create_unique_constraint(op.f("uq_categories_name"), "categories", ["name"])
    op.drop_index("uq_categories_lower_name", table_name="categories")
