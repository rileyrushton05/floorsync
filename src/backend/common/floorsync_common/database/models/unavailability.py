from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.machine import Machine


class Unavailability(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A known-in-advance window when a machine cannot be scheduled (maintenance, holiday, ...).

    Read once at schedule-generation time, same as Compatibility or Dependency -- not part of any
    live/dynamic repair mechanism, which stays out of scope.

    TODO: an EXCLUDE USING gist (machine_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
    constraint would prevent overlapping windows per machine, but needs the btree_gist extension
    enabled first. Not wired up yet -- see docs/database-schema.md.
    """

    __tablename__ = "unavailabilities"
    __table_args__ = (CheckConstraint("ends_at > starts_at", name="ends_after_starts"),)

    machine_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("machines.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)

    machine: Mapped[Machine] = relationship()
