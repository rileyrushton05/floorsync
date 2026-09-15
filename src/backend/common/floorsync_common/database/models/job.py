from datetime import datetime
from typing import Literal

from sqlalchemy import CheckConstraint, DateTime, Text
from sqlalchemy.orm import Mapped, mapped_column

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

type JobPriority = Literal["high", "med", "low"]


class Job(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A production job made up of one or more operations.

    Jobs are independent of one another: there is no job-to-job dependency, by design. Precedence
    is an operation-level fact on `dependencies`, and an edge may cross jobs only at that level.
    """

    __tablename__ = "jobs"
    __table_args__ = (CheckConstraint("priority IN ('high', 'med', 'low')", name="priority_valid"),)

    name: Mapped[str] = mapped_column(Text, nullable=False)
    # Lower-case in the database and API; the frontend maps to its own High/Med/Low labels. The
    # server default is what lets a row that predates the column, or one inserted by the seed
    # loader, exist without stating one.
    priority: Mapped[JobPriority] = mapped_column(Text, nullable=False, server_default="med")
    # When the job left the backlog, or NULL while it is still open. Archiving is how a finished or
    # cancelled job stops being offered for scheduling without being deleted: a job a confirmed
    # schedule planned cannot be deleted, because the schedule is the record of what was decided
    # (see decision 0015). Set by hand through the jobs API, or automatically for every job in a
    # schedule whose simulation completes.
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
