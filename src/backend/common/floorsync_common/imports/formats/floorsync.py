"""The FloorSync JSON import format, declared once as Pydantic models.

Validation collects every problem in a file in one pass, and `FloorSyncImportService.read`
translates them into the import's issue codes and file locations, so a person fixing a
hand-written file sees everything wrong at once.

Pydantic's defaults differ from what this format means in a few places, so those fields carry
explicit validators:

- A number is never text and text is never a number, and `true` is neither.
- A whole number may be written `30.0`, but not `2.5`, and an absurd one (`1e5000000`) is refused
  before it is turned into an integer, which alone would take minutes.
- An optional field may be left out, but an explicit `null` is a mistake.
- `after` left out means the file did not say; `after: []` says the operation waits for nothing.

Nothing here touches the database.
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError
from pydantic_core import ErrorDetails, PydanticCustomError

from floorsync_common.database.models.job import JobPriority
from floorsync_common.imports.plan import (
    ImportFormat,
    ImportIssue,
    ImportIssueCode,
    ImportPlan,
    PlannedJob,
    PlannedMachine,
    PlannedOperation,
    PlannedRoute,
)
from floorsync_common.imports.results import FileUnreadable, PlanRead, ReadFileResult
from floorsync_common.imports.validation import ImportValidationService

FLOORSYNC_VERSION = 1

MAX_WHOLE_NUMBER_DIGITS = 18
"""Bigger than any whole number a field takes, and small enough that `int()` stays cheap."""


# Each validator raises an error whose type is the import's own issue code, so translating it in
# `_issue` is a lookup.


def _text(value: object) -> str:
    if not isinstance(value, str):
        raise PydanticCustomError(ImportIssueCode.WRONG_TYPE, "Expected text.")
    stripped = value.strip()
    if not stripped:
        raise PydanticCustomError(
            ImportIssueCode.INVALID_VALUE, "Must not be blank; leave an optional field out."
        )
    if "\x00" in stripped:
        raise PydanticCustomError(
            ImportIssueCode.INVALID_VALUE, "Must not contain a NUL character."
        )
    return stripped


def _whole_number(value: object) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, Decimal):
        if value.adjusted() >= MAX_WHOLE_NUMBER_DIGITS:
            raise PydanticCustomError(ImportIssueCode.INVALID_VALUE, "Too large to be used here.")
        if value == value.to_integral_value():
            return int(value)
    raise PydanticCustomError(ImportIssueCode.WRONG_TYPE, "Expected a whole number.")


def _number(value: object) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        raise PydanticCustomError(ImportIssueCode.WRONG_TYPE, "Expected a number.")
    return Decimal(value)


def _not_null(value: object) -> object:
    if value is None:
        raise PydanticCustomError(ImportIssueCode.WRONG_TYPE, "Expected a list.")
    return value


type _Text = Annotated[str, BeforeValidator(_text)]
type _OptionalText = Annotated[str | None, BeforeValidator(_text)]
type _WholeNumber = Annotated[int, BeforeValidator(_whole_number)]
type _OptionalNumber = Annotated[Decimal | None, BeforeValidator(_number)]


class _FileObject(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class _Route(_FileObject):
    machine: _Text
    duration: _WholeNumber
    energy: _OptionalNumber = None


class _Operation(_FileObject):
    name: _Text
    routes: Annotated[list[_Route], Field(min_length=1)]
    after: Annotated[list[_Text] | None, BeforeValidator(_not_null)] = None


class _Job(_FileObject):
    name: _Text
    priority: JobPriority = "med"
    operations: Annotated[list[_Operation], Field(min_length=1)]


class _Machine(_FileObject):
    name: _Text
    category: _OptionalText = None
    salary: _OptionalNumber = None


class _File(_FileObject):
    format: Literal[ImportFormat.FLOORSYNC]
    version: _WholeNumber
    machines: list[_Machine] = Field(default_factory=list)
    jobs: Annotated[list[_Job], Field(min_length=1)]


class FloorSyncImportService:
    """Reads the FloorSync JSON format, which we define."""

    @staticmethod
    def read(document: Mapping[str, object]) -> ReadFileResult:
        """Read a FloorSync document into a plan, or report every problem in its shape at once."""

        # Nothing else in a file of another version can be trusted to mean the same thing, so it is
        # refused on its own.
        try:
            version: int | None = _whole_number(document.get("version"))
        except PydanticCustomError:
            version = (
                None  # Missing or not a whole number: reported with every other problem below.
            )
        if version is not None and version != FLOORSYNC_VERSION:
            return FileUnreadable(
                issues=(
                    ImportIssue(
                        ImportIssueCode.UNSUPPORTED_VERSION,
                        f"The file is FloorSync format version {version}; this FloorSync reads "
                        f"version {FLOORSYNC_VERSION}.",
                    ),
                )
            )

        try:
            file = _File.model_validate(document)
        except ValidationError as error:
            issues = [_issue(detail) for detail in error.errors()]
            # The file cannot be imported, but its well-formed machines and jobs can still be
            # checked, so one upload shows their value problems too, not one round at a time.
            issues.extend(ImportValidationService.check_plan(_intact_parts(document)))
            return FileUnreadable(issues=tuple(issues))

        return PlanRead(
            plan=ImportPlan(
                format=ImportFormat.FLOORSYNC,
                machines=tuple(
                    _planned_machine(machine, index) for index, machine in enumerate(file.machines)
                ),
                jobs=tuple(_planned_job(job, index) for index, job in enumerate(file.jobs)),
            )
        )


def _intact_parts(document: Mapping[str, object]) -> ImportPlan:
    """The machines and jobs whose own shape is valid, each at its place in the file.

    Each is validated alone, so a broken job does not hide a well-formed one beside it. Nothing is
    made up to fill a gap: a part with any shape problem is left out (its problem is already
    reported), so cross-part checks such as duplicate machine names may miss one, but never
    report one that is not in the file.
    """

    machines: list[PlannedMachine] = []
    listed_machines = document.get("machines")
    for index, item in enumerate(listed_machines if isinstance(listed_machines, list) else []):
        try:
            machines.append(_planned_machine(_Machine.model_validate(item), index))
        except ValidationError:
            continue
    jobs: list[PlannedJob] = []
    listed_jobs = document.get("jobs")
    for index, item in enumerate(listed_jobs if isinstance(listed_jobs, list) else []):
        try:
            jobs.append(_planned_job(_Job.model_validate(item), index))
        except ValidationError:
            continue
    return ImportPlan(format=ImportFormat.FLOORSYNC, machines=tuple(machines), jobs=tuple(jobs))


def _planned_machine(machine: _Machine, index: int) -> PlannedMachine:
    return PlannedMachine(
        name=machine.name,
        category=machine.category,
        salary=machine.salary,
        location=f"machines[{index}]",
    )


def _planned_job(job: _Job, index: int) -> PlannedJob:
    job_location = f"jobs[{index}]"
    operations: list[PlannedOperation] = []
    for operation_index, operation in enumerate(job.operations):
        location = f"{job_location}.operations[{operation_index}]"
        routes = tuple(
            PlannedRoute(
                machine=route.machine,
                duration=route.duration,
                energy=route.energy,
                location=f"{location}.routes[{route_index}]",
            )
            for route_index, route in enumerate(operation.routes)
        )
        after = None if operation.after is None else tuple(operation.after)
        operations.append(
            PlannedOperation(name=operation.name, routes=routes, after=after, location=location)
        )
    return PlannedJob(
        name=job.name, priority=job.priority, operations=tuple(operations), location=job_location
    )


def _issue(detail: ErrorDetails) -> ImportIssue:
    """One Pydantic validation error as an import issue at its place in the file."""

    path = detail["loc"]
    # `("jobs", 2, "operations", 0)` is written `jobs[2].operations[0]`.
    location = ""
    for segment in path:
        if isinstance(segment, int):
            location += f"[{segment}]"
        else:
            location += f".{segment}" if location else segment

    match detail["type"]:
        case "missing":
            code, message = ImportIssueCode.MISSING_FIELD, f"{path[-1]!r} is required."
        case "extra_forbidden":
            code, message = ImportIssueCode.UNKNOWN_FIELD, f"{path[-1]!r} is not a field here."
        case "model_type" | "model_attributes_type" | "dict_type":
            code, message = ImportIssueCode.WRONG_TYPE, "Expected an object."
        case "list_type":
            code, message = ImportIssueCode.WRONG_TYPE, "Expected a list."
        case ImportIssueCode.WRONG_TYPE:
            code, message = ImportIssueCode.WRONG_TYPE, detail["msg"]
        case _:
            code, message = ImportIssueCode.INVALID_VALUE, detail["msg"]
    return ImportIssue(code, message, location or None)
