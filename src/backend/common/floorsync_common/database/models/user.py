from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.machine import Machine


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A login. An operator's login is tied to exactly one machine at a time ("each machine has
    its own login"); a manager's is not. Creating a machine creates its operator, and a manager can
    later swap two operators' machines -- see floorsync_common.users.
    """

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('operator', 'manager')", name="role_valid"),
        CheckConstraint(
            "(role = 'operator') = (machine_id IS NOT NULL)",
            name="operator_role_matches_machine",
        ),
        # Deferrable so a single statement can swap two operators' machines: the check above
        # forbids parking either one on NULL in between. Still checked at the end of every
        # statement, so an ordinary duplicate fails where it always did.
        UniqueConstraint("machine_id", deferrable=True, initially="IMMEDIATE"),
    )

    name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    machine_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("machines.id", ondelete="SET NULL"),
        nullable=True,
    )

    machine: Mapped[Machine | None] = relationship()
