"""Expected outcomes for job operations.

Creating a job has no expected failure: a job carries only a name, names are deliberately not
unique, and it references nothing. So `create_job` returns the row itself rather than a union of
one.
"""

from dataclasses import dataclass
from uuid import UUID

from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
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


type GetJobResult = JobFound | JobNotFound
type UpdateJobResult = JobUpdated | JobNotFound
type DeleteJobResult = JobDeleted | JobNotFound | JobIsScheduled
