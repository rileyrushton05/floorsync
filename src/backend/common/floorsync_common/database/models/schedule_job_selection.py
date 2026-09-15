from __future__ import annotations

from uuid import UUID

from sqlalchemy import ForeignKey, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin


class ScheduleJobSelection(TimestampMixin, Base):
    """Which jobs a schedule was *asked* to plan, when the request named a subset (#231).

    Not derivable from `schedule_entries`. The entries record which operations were placed, which
    answers "what got planned" but not "what was asked for" -- those differ whenever a selected job
    turns out to hold no schedulable work, and a schedule that says only the former cannot explain
    why the floor's other jobs are absent.

    Absence is meaningful: a schedule with no rows here was generated for the whole floor, which is
    every schedule made before this table existed and every unscoped run since. A scoped run always
    writes at least one row, because an empty selection is refused before generation
    (`selection.EMPTY_SELECTION`), so the two cases never collide and no separate flag is needed.

    The composite key is the whole row: a schedule names a job at most once, and there is nothing
    else to record about the pairing.
    """

    __tablename__ = "schedule_job_selections"

    schedule_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("schedules.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # RESTRICT, matching how `schedule_entries` protects the operations it planned: a schedule is a
    # record of what was decided, and deleting a job it names would quietly rewrite that history.
    # In practice this rarely fires on its own -- a job whose operations reached a schedule is
    # already undeletable through `schedule_entries.operation_id` -- but the two agree by design
    # rather than by luck.
    job_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("jobs.id", ondelete="RESTRICT"),
        primary_key=True,
        index=True,
    )
