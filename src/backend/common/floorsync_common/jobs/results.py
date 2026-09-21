"""Expected outcomes for job operations.

Creating a job has no expected failure: a job carries only a name, names are deliberately not
unique, and it references nothing. So `create_job` returns the row itself rather than a union of
one.
"""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.jobs.backlog import JobBacklog
from floorsync_common.outcomes import ExpectedOutcome
from floorsync_common.scheduling.references import ScheduleReferences


@dataclass(frozen=True, slots=True)
class JobFound:
    job: Job
    operations: tuple[Operation, ...]


@dataclass(frozen=True, slots=True)
class JobUpdated:
    job: Job


@dataclass(frozen=True, slots=True)
class JobDeleted:
    job_id: UUID


@dataclass(frozen=True, slots=True)
class JobNotFound(ExpectedOutcome):
    job_id: UUID


@dataclass(frozen=True, slots=True)
class JobIsScheduled(ExpectedOutcome):
    """The job's work appears in a schedule, so removing it would destroy that schedule's history.

    `schedule_entries.operation_id` restricts deletion for exactly this reason; refusing here gives
    the caller a reason instead of an integrity error. `references` says which schedules, split by
    whether deleting them would clear the way: drafts can be, confirmed schedules cannot (decision
    0015). A job that must leave the backlog while a confirmed schedule names it is archived, not
    deleted.
    """

    job_id: UUID
    references: ScheduleReferences


@dataclass(frozen=True, slots=True)
class JobHasLeftBacklog(ExpectedOutcome):
    """The job is no longer open, and only an open job can be changed.

    Every path that changes what a job is (its fields, its operations, its routes, its ordering)
    refuses unless `backlog_status` is `open`, so the "read it, duplicate it, edit the copy" flow
    the jobs page offers is a rule the API enforces rather than a courtesy the browser extends
    (decision 0018, extended by 0019). A planned job comes back to the backlog when the schedule
    that claims it is discarded; a done or archived job does not come back at all.
    """

    job_id: UUID
    backlog: JobBacklog
    archived_at: datetime | None


type GetJobResult = JobFound | JobNotFound
type UpdateJobResult = JobUpdated | JobNotFound | JobHasLeftBacklog
type DeleteJobResult = JobDeleted | JobNotFound | JobIsScheduled
