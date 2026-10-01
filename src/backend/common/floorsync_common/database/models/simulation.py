from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Numeric, Text, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.schedule import Schedule

type SimulationStatus = Literal["not_started", "running", "paused", "complete"]

SIMULATION_NOT_STARTED: SimulationStatus = "not_started"
SIMULATION_RUNNING: SimulationStatus = "running"
SIMULATION_PAUSED: SimulationStatus = "paused"
SIMULATION_COMPLETE: SimulationStatus = "complete"
"""The values of the `status_valid` check constraint below, defined once beside it."""


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
    # How many `simulation.changed` notifications this simulation has issued (#148). Allocated
    # atomically by `LiveUpdateOutboxService`; a client orders and gap-checks messages by it.
    live_sequence: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default=text("0")
    )

    schedule: Mapped[Schedule] = relationship()
