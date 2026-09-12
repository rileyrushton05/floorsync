from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.machine import Machine
    from floorsync_common.database.models.operation import Operation
    from floorsync_common.database.models.schedule import Schedule


class ScheduleEntry(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One operation assigned to one machine within a schedule.

    Duration, energy and machine_salary are snapshotted from Compatibility/Machine at generation
    time so a schedule's reported cost never silently changes. start_time is written by the
    scheduler at generation time (see decision 0011); end time and queue position are still derived
    -- as start_time + duration, and by sorting a machine's entries on start_time -- rather than
    stored, since neither can disagree with the number beside it. Cost snapshots are nullable when
    the source records durations but no energy or labour cost. start_time is nullable only because
    schedules written before this column existed cannot backfill it without the derivation it
    replaces; every schedule generated from here on sets it.
    """

    __tablename__ = "schedule_entries"
    __table_args__ = (UniqueConstraint("schedule_id", "operation_id"),)

    schedule_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("schedules.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    operation_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("operations.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    machine_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("machines.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    duration: Mapped[int] = mapped_column(Integer, nullable=False)
    energy: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    machine_salary: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    start_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    schedule: Mapped[Schedule] = relationship()
    operation: Mapped[Operation] = relationship()
    machine: Mapped[Machine] = relationship()
