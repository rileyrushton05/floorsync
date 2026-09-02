from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Numeric, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.schedule import Schedule


class Simulation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """The playback of one confirmed schedule.

    started_at + speed alone can't correctly derive simulated time across a pause -- see
    SimulationEvent, which is the actual source for that derivation.
    """

    __tablename__ = "simulations"
    __table_args__ = (
        CheckConstraint(
            "status IN ('not_started', 'running', 'paused', 'complete')", name="status_valid"
        ),
    )

    schedule_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("schedules.id", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
        index=True,
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    speed: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, server_default="1")
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    schedule: Mapped[Schedule] = relationship()
