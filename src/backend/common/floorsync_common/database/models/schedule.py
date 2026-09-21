from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Numeric, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.user import User

type ScheduleStatus = Literal["draft", "confirmed", "discarded"]

SCHEDULE_DRAFT: ScheduleStatus = "draft"
SCHEDULE_CONFIRMED: ScheduleStatus = "confirmed"
SCHEDULE_DISCARDED: ScheduleStatus = "discarded"
"""The values of the `status_valid` check constraint below, defined once beside it."""


class Schedule(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A generated set of operation-to-machine assignments.

    total_energy/total_labour_cost, like makespan, are written once at generation time and summed
    from schedule_entries -- cached results, never an independently maintained fact.
    """

    __tablename__ = "schedules"
    __table_args__ = (
        CheckConstraint("status IN ('draft', 'confirmed', 'discarded')", name="status_valid"),
    )

    status: Mapped[ScheduleStatus] = mapped_column(Text, nullable=False)
    strategy: Mapped[str] = mapped_column(Text, nullable=False)
    runtime_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    input_operation_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    makespan: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_energy: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    total_labour_cost: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    confirmed_by_user_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    confirmed_by: Mapped[User | None] = relationship()
