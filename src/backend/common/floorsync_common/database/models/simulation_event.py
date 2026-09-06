from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Numeric, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.simulation import Simulation


class SimulationEvent(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One playback control action.

    An append-only log: replaying it against `speed` is what correctly derives simulated time across
    pause/resume/speed changes, and it doubles as the audit trail of what happened, when.
    """

    __tablename__ = "simulation_events"
    __table_args__ = (
        CheckConstraint(
            "event_type IN ('started', 'paused', 'resumed', 'speed_changed', 'reset', 'completed')",
            name="event_type_valid",
        ),
    )

    simulation_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("simulations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    speed: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)

    simulation: Mapped[Simulation] = relationship()
