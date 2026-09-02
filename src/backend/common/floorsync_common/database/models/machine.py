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
    """A production machine that can be assigned scheduled operations."""

    __tablename__ = "machines"

    category_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("categories.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    salary: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")

    category: Mapped[Category] = relationship()
