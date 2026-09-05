from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.schedule_entry import ScheduleEntry


class ScheduleDependency(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """What a schedule entry is waiting on, rebuilt from scratch every time a schedule is generated.

    A disposable cache, not an independent source of truth -- see docs/database-schema.md.
    """

    __tablename__ = "schedule_dependencies"
    __table_args__ = (
        UniqueConstraint("schedule_entry_id", "depends_on_schedule_entry_id"),
        CheckConstraint(
            "schedule_entry_id <> depends_on_schedule_entry_id", name="not_self_referential"
        ),
        CheckConstraint("reason IN ('job_order', 'machine_queue')", name="reason_valid"),
    )

    schedule_entry_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("schedule_entries.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    depends_on_schedule_entry_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("schedule_entries.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)

    schedule_entry: Mapped[ScheduleEntry] = relationship(foreign_keys=[schedule_entry_id])
    depends_on_schedule_entry: Mapped[ScheduleEntry] = relationship(
        foreign_keys=[depends_on_schedule_entry_id]
    )
