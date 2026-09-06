from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import ForeignKey, Integer, Numeric, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.machine import Machine
    from floorsync_common.database.models.operation import Operation
    from floorsync_common.database.models.schedule import Schedule


class ScheduleEntry(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One operation assigned to one machine within a schedule.

    No start/end time and no queue position -- both are derived from Schedule Dependency at read
    time, not stored (see docs/database-schema.md). duration/energy/machine_salary are snapshotted
    from Compatibility/Machine at generation time so a schedule's reported cost never silently
    changes if that source data changes later.

    energy and machine_salary are nullable because the values they snapshot are: a scenario seeded
    from an academic benchmark records durations only. A NULL here means the source carried no such
    cost when the schedule was generated, so cost reporting must exclude the entry rather than sum
    it as zero. duration stays required -- a schedule entry without one cannot be sequenced.
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

    schedule: Mapped[Schedule] = relationship()
    operation: Mapped[Operation] = relationship()
    machine: Mapped[Machine] = relationship()
