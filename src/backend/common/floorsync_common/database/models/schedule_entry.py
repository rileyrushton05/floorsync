from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.machine import Machine
    from floorsync_common.database.models.operation import Operation
    from floorsync_common.database.models.schedule import Schedule


class ScheduleEntry(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One operation assigned to one machine within a schedule.

    Planned timestamps are stored rather than inferred from the dependency graph. A graph alone
    cannot represent a gap imposed by machine downtime, and recomputing against edited downtime
    would rewrite historical plans. duration/energy/machine_salary are snapshotted from
    Compatibility/Machine at generation time so a schedule's reported cost never silently changes.
    Cost snapshots are nullable when the source records durations but no energy or labour cost.
    """

    __tablename__ = "schedule_entries"
    __table_args__ = (
        UniqueConstraint("schedule_id", "operation_id"),
        CheckConstraint("ends_at > starts_at", name="ends_after_starts"),
    )

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
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    duration: Mapped[int] = mapped_column(Integer, nullable=False)
    energy: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    machine_salary: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)

    schedule: Mapped[Schedule] = relationship()
    operation: Mapped[Operation] = relationship()
    machine: Mapped[Machine] = relationship()
