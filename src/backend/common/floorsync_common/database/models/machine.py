from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import Boolean, ForeignKey, Numeric, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.category import Category


class Machine(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A production machine that can be assigned scheduled operations.

    category_id and salary are nullable because not every data source carries them. An academic
    job-shop benchmark describes machines only as indices with per-operation durations, so a machine
    seeded from one has no category and no known labour cost. NULL means "not recorded by the source
    this machine came from", not "free" or "uncategorised" -- cost reporting must exclude such a
    machine rather than treat it as zero. See docs/database-schema.md.
    """

    __tablename__ = "machines"

    category_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("categories.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    salary: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")

    category: Mapped[Category | None] = relationship()
