"""Expected outcomes for the job-definition builder.

`JobNotFound` is reused from `floorsync_common.jobs.results` rather than redeclared here, per the
same reasoning `floorsync_common.machines.results` re-imports `OperationNotFound`: a second class of
the same name would not be caught by the same `case` pattern in an exhaustive match.
"""

from dataclasses import dataclass
from uuid import UUID

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation
from floorsync_common.jobs.results import JobNotFound
from floorsync_common.outcomes import ExpectedOutcome


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
    """One of this job's operations already appears in a generated schedule.

    Saving a definition over it would rewrite inputs, or graph edges, a schedule already recorded
    as having been used to produce that schedule -- this v1 policy refuses the save instead.
    """

    job_id: UUID


type CreateDefinitionResult = DefinitionCreated | UnknownMachine | InactiveMachine
type GetDefinitionResult = DefinitionFound | JobNotFound
type ReplaceDefinitionResult = (
    DefinitionReplaced
    | JobNotFound
    | JobDefinitionIsScheduled
    | OperationDoesNotBelongToJob
    | UnknownMachine
    | InactiveMachine
)
