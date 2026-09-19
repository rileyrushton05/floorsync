"""Expected outcomes for operation and ordering operations.

Every variant a caller must handle is a concrete type rather than an exception, so the web edge can
match exhaustively and map each one to its own status code. See docs/backend-conventions.md.

`OperationNotFound` lives here rather than beside the capability outcomes that first needed it. An
operation belongs to this domain, and a second class of the same name elsewhere would be a different
type: it would not be caught by the same `case` pattern, which is exactly the kind of near-miss an
exhaustive match is supposed to rule out.
"""

from dataclasses import dataclass
from uuid import UUID

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.operation import Operation
from floorsync_common.jobs.results import JobHasLeftBacklog, JobNotFound
from floorsync_common.outcomes import ExpectedOutcome
from floorsync_common.scheduling.references import ScheduleReferences


@dataclass(frozen=True, slots=True)
class OperationCreated:
    operation: Operation


@dataclass(frozen=True, slots=True)
class OperationFound:
    """An operation with everything needed to show it without reading the rest of the floor.

    `compatibilities` is which machines can run it and what each costs. The two edge tuples are its
    place in the ordering: what it waits on, and what waits on it.
    """

    operation: Operation
    compatibilities: tuple[Compatibility, ...]
    predecessors: tuple[Dependency, ...]
    successors: tuple[Dependency, ...]


@dataclass(frozen=True, slots=True)
class OperationUpdated:
    operation: Operation


@dataclass(frozen=True, slots=True)
class OperationDeleted:
    operation_id: UUID


@dataclass(frozen=True, slots=True)
class OperationNotFound(ExpectedOutcome):
    operation_id: UUID


@dataclass(frozen=True, slots=True)
class OperationIsScheduled(ExpectedOutcome):
    """The operation appears in a schedule, so removing it would destroy that schedule's history.

    `schedule_entries.operation_id` restricts deletion for exactly this reason; refusing here gives
    the caller a reason instead of an integrity error. Same policy as deleting a job: `references`
    names the schedules, and only the drafts among them can be deleted to clear the way.
    """

    operation_id: UUID
    references: ScheduleReferences


type CreateOperationResult = OperationCreated | JobNotFound | JobHasLeftBacklog
type GetOperationResult = OperationFound | OperationNotFound
type UpdateOperationResult = OperationUpdated | OperationNotFound | JobHasLeftBacklog
type DeleteOperationResult = (
    OperationDeleted | OperationNotFound | OperationIsScheduled | JobHasLeftBacklog
)


@dataclass(frozen=True, slots=True)
class JobDependenciesListed:
    dependencies: tuple[Dependency, ...]


@dataclass(frozen=True, slots=True)
class JobDependenciesReplaced:
    dependencies: tuple[Dependency, ...]


@dataclass(frozen=True, slots=True)
class OperationNotInJob(ExpectedOutcome):
    """An edge tried to order an operation that belongs to a different job.

    Only the `after` side is restricted this way: a job owns what its own steps wait on, so the
    `before` side is deliberately free to name an operation in another job.
    """

    operation_id: UUID
    job_id: UUID


@dataclass(frozen=True, slots=True)
class DependencyCycle(ExpectedOutcome):
    """The submitted ordering describes work that could never start.

    Carries every operation caught in a cycle rather than one path through it: there may be several
    cycles, and all of them have to be broken before the ordering can be saved.
    """

    operation_ids: tuple[UUID, ...]


type ListJobDependenciesResult = JobDependenciesListed | JobNotFound
type ReplaceJobDependenciesResult = (
    JobDependenciesReplaced
    | JobNotFound
    | JobHasLeftBacklog
    | OperationNotFound
    | OperationNotInJob
    | DependencyCycle
)
