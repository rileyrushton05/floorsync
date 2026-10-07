"""What an import file says, in one shape whatever format it arrived in.

Every supported format is translated into an `ImportPlan` before anything else looks at it, so the
checks and the writer are written once. A plan refers to machines and operations by name, because a
file cannot know the ids our database will give them, and records where in the file each part came
from so a problem can point at the exact spot.

Nothing here touches the database.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from floorsync_common.database.models.job import JobPriority


class ImportFormat(StrEnum):
    """What an upload is: our own JSON, or a ScheduleOpt classic or flexible job shop."""

    FLOORSYNC = "floorsync"
    JOBSHOP = "jobshop"
    FLEXIBLE_JOBSHOP = "flexible-jobshop"


class ImportIssueCode(StrEnum):
    """Every issue an import can report. Stable API values, listed in docs/importing.md."""

    # The file as a whole could not be read.
    EMPTY_FILE = "empty_file"
    NOT_UTF8 = "not_utf8"
    NOT_JSON = "not_json"
    DUPLICATE_KEY = "duplicate_key"
    TOO_DEEPLY_NESTED = "too_deeply_nested"
    NOT_AN_OBJECT = "not_an_object"
    UNKNOWN_FORMAT = "unknown_format"
    UNSUPPORTED_VERSION = "unsupported_version"
    INVALID_BENCHMARK = "invalid_benchmark"
    TOO_LARGE = "too_large"
    # A FloorSync file's shape.
    MISSING_FIELD = "missing_field"
    UNKNOWN_FIELD = "unknown_field"
    WRONG_TYPE = "wrong_type"
    INVALID_VALUE = "invalid_value"
    # What the file says, checked against itself.
    DUPLICATE_MACHINE = "duplicate_machine"
    DUPLICATE_ROUTE = "duplicate_route"
    DUPLICATE_OPERATION_NAME = "duplicate_operation_name"
    UNKNOWN_PREDECESSOR = "unknown_predecessor"
    PREDECESSOR_NOT_EARLIER = "predecessor_not_earlier"
    DUPLICATE_DEPENDENCY = "duplicate_dependency"
    # What the file says, checked against the floor.
    UNKNOWN_MACHINE = "unknown_machine"
    INACTIVE_MACHINE = "inactive_machine"
    # Warnings: worth knowing, but nothing stops the import.
    MACHINE_DIFFERS = "machine_differs"
    SIMILAR_MACHINE_NAME = "similar_machine_name"
    RESCHED_UNSUPPORTED = "resched_unsupported"


@dataclass(frozen=True, slots=True)
class ImportIssue:
    """One thing wrong with, or worth knowing about, a file.

    `code` is a stable identifier a client can branch on; `message` is for a person. `location`
    points into the file (`jobs[2].operations[0].routes[1].duration`) when the problem has one
    place, and is `None` when it is about the file as a whole.
    """

    code: ImportIssueCode
    message: str
    location: str | None = None


@dataclass(frozen=True, slots=True)
class PlannedMachine:
    """A machine the file declares. Reused by name when the floor already has it."""

    name: str
    category: str | None
    salary: Decimal | None
    location: str


@dataclass(frozen=True, slots=True)
class PlannedRoute:
    """One machine an operation can run on, named rather than referenced by id."""

    machine: str
    duration: int
    energy: Decimal | None
    location: str


@dataclass(frozen=True, slots=True)
class PlannedOperation:
    """One step of a job.

    `after` names the operations of the same job this one waits for. `None` means the file did not
    say, as opposed to `()`, which says it waits for nothing. A job whose operations all leave it
    unsaid runs them in the order listed.
    """

    name: str
    routes: tuple[PlannedRoute, ...]
    after: tuple[str, ...] | None
    location: str


@dataclass(frozen=True, slots=True)
class PlannedJob:
    name: str
    priority: JobPriority
    operations: tuple[PlannedOperation, ...]
    location: str

    @property
    def states_precedence(self) -> bool:
        """Whether the file gave this job's precedence explicitly, rather than by list order."""

        return any(operation.after is not None for operation in self.operations)


@dataclass(frozen=True, slots=True)
class ImportPlan:
    """Everything a file asks to add, before any of it has been checked against the floor."""

    format: ImportFormat
    machines: tuple[PlannedMachine, ...]
    jobs: tuple[PlannedJob, ...]

    @property
    def operation_count(self) -> int:
        return sum(len(job.operations) for job in self.jobs)

    @property
    def route_count(self) -> int:
        return sum(len(operation.routes) for job in self.jobs for operation in job.operations)
