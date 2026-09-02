from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.machine import Machine


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A login. An operator's login is permanently tied to exactly one machine ("each machine has
    its own login"); a manager's is not.
    """

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('operator', 'manager')", name="role_valid"),
        CheckConstraint(
            "(role = 'operator') = (machine_id IS NOT NULL)",
            name="operator_role_matches_machine",
        ),
    )

    name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    machine_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("machines.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
        index=True,
    )

    machine: Mapped[Machine | None] = relationship()
