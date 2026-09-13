from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Integer, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.job import Job


class Operation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A single step within a job.

    `position` is the step's place in its job as the job builder shows and edits it: a stable,
    1-based display order. It is not precedence -- that stays on `dependencies`, which can express
    shapes a single number cannot (an operation waiting on several others). The definition service
    derives a straight chain of edges from consecutive positions; anything richer is written to
    `dependencies` directly and is untouched by a position change.

    The unique constraint is deferred to commit so a reorder can be written as one set of updates.
    Checked immediately, swapping two positions would fail on the first update because the second
    row still holds the value being moved to. The database still refuses a duplicate; it refuses it
    at the end of the transaction rather than half-way through the reorder.
    """

    __tablename__ = "operations"
    __table_args__ = (
        CheckConstraint("position >= 1", name="position_positive"),
        UniqueConstraint("job_id", "position", deferrable=True, initially="DEFERRED"),
    )

    job_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)

    job: Mapped[Job] = relationship()
