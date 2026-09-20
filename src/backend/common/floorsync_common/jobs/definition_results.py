"""Expected outcomes for the job-definition builder.

`JobNotFound` is reused from `floorsync_common.jobs.results`, and `DependencyCycle` from
`floorsync_common.operations.results`, rather than redeclared here -- per the same reasoning
`floorsync_common.machines.results` re-imports `OperationNotFound`: a second class of the same name
would not be caught by the same `case` pattern in an exhaustive match.
"""

from dataclasses import dataclass
from uuid import UUID

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.jobs.results import JobIsArchived, JobNotFound
from floorsync_common.operations.results import DependencyCycle
from floorsync_common.outcomes import ExpectedOutcome
from floorsync_common.scheduling.references import ScheduleReferences


@dataclass(frozen=True, slots=True)
class OperationWithRoutes:
    """One operation together with every machine route it can run on."""

    operation: Operation
    routes: tuple[Compatibility, ...]


@dataclass(frozen=True, slots=True)
class JobDefinitionRead:
    """A job with every operation and route needed to redraw the builder, in position order."""

    job: Job
    operations: tuple[OperationWithRoutes, ...]


@dataclass(frozen=True, slots=True)
class DefinitionCreated:
    definition: JobDefinitionRead


@dataclass(frozen=True, slots=True)
class DefinitionFound:
    definition: JobDefinitionRead


@dataclass(frozen=True, slots=True)
class DefinitionReplaced:
    definition: JobDefinitionRead


@dataclass(frozen=True, slots=True)
class DefinitionsListed:
    definitions: tuple[JobDefinitionRead, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class UnknownMachine(ExpectedOutcome):
    """A route names a machine id that does not exist."""

    machine_id: UUID


@dataclass(frozen=True, slots=True)
class InactiveMachine(ExpectedOutcome):
    """A route names a machine that exists but is retired, so it cannot be scheduled."""

    machine_id: UUID


@dataclass(frozen=True, slots=True)
class OperationDoesNotBelongToJob(ExpectedOutcome):
    """A replacement supplied an operation id from another job, or a stale one."""

    operation_id: UUID
    job_id: UUID


@dataclass(frozen=True, slots=True)
class JobDefinitionIsScheduled(ExpectedOutcome):
    """This save would remove an operation a generated schedule already recorded.

    Only removal is refused. Everything else a save can change is already snapshotted per schedule:
    `schedule_entries` copies duration, energy, machine salary, machine and start time at
    generation, and `schedule_dependencies` copies the graph, so a rename, a route change, a
    reorder or an added step cannot rewrite what a schedule recorded (the ordering endpoint allows
    the same edits for the same reason). Deleting an operation is different: the entry would point
    at nothing, and `schedule_entries.operation_id` is ON DELETE RESTRICT, so without this check the
    database would refuse the write and the caller would get an integrity error instead of a reason.
    `references` names the schedules in the way; only the drafts among them can be deleted to clear
    it (decision 0015).
    """

    job_id: UUID
    references: ScheduleReferences


@dataclass(frozen=True, slots=True)
class OperationHasExternalDependents(ExpectedOutcome):
    """Removing this operation would cascade-delete an edge a different job's own edge still names.

    `before_operation_id` may cross jobs by design (#125), and `ON DELETE CASCADE` on
    `dependencies` cannot tell that the edge belongs to a job other than the one being saved.
    `job_id` names the *other* job whose edge would be lost, not the job being replaced.
    """

    operation_id: UUID
    job_id: UUID


type CreateDefinitionResult = DefinitionCreated | UnknownMachine | InactiveMachine
type GetDefinitionResult = DefinitionFound | JobNotFound
type ReplaceDefinitionResult = (
    DefinitionReplaced
    | JobNotFound
    | JobIsArchived
    | JobDefinitionIsScheduled
    | OperationDoesNotBelongToJob
    | OperationHasExternalDependents
    | DependencyCycle
    | UnknownMachine
    | InactiveMachine
)
