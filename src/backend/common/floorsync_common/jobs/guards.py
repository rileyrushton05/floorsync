"""The one check every write to a job makes first: is the job still open? (decisions 0018, 0019)

Kept apart from `backlog` so that module stays free of outcome imports, and apart from the job
service so the operations and definition services can share it without importing each other.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.job import Job
from floorsync_common.jobs.backlog import BacklogService
from floorsync_common.jobs.results import JobHasLeftBacklog


async def refuse_unless_open(db: AsyncSession, job: Job) -> JobHasLeftBacklog | None:
    """The refusal a job that has left the backlog gives every edit, or None for an open job.

    One read; call it before anything else is read or written so a refused save leaves every
    table exactly as it was.
    """

    backlog = (await BacklogService.load(db, [job]))[job.id]
    if backlog.status == "open":
        return None
    return JobHasLeftBacklog(job_id=job.id, backlog=backlog, archived_at=job.archived_at)


__all__ = ["refuse_unless_open"]
