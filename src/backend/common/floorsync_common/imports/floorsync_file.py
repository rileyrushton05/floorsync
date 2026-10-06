"""The FloorSync JSON import format, declared once as Pydantic models.

The models say which fields each object has, which are required, and what each holds. Validation
collects every problem in a file in one pass; `read_floorsync_file` translates them into the
import's stable issue codes and file locations, so a person fixing a hand-written file sees
everything wrong at once.

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

from collections.abc import Mapping, Sequence
from decimal import Decimal
from types import UnionType
from typing import Annotated, Any, Literal, Union, get_args, get_origin

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, ValidationError
from pydantic_core import ErrorDetails, PydanticCustomError

from floorsync_common.imports.plan import (
    ImportIssue,
    ImportPlan,
    PlannedJob,
    PlannedMachine,
    PlannedOperation,
    PlannedPriority,
    PlannedRoute,
)
from floorsync_common.imports.results import FileUnreadable, PlanRead, ReadFileResult

FLOORSYNC_FORMAT = "floorsync"
FLOORSYNC_VERSION = 1
PRIORITIES: tuple[PlannedPriority, ...] = ("high", "med", "low")

MAX_WHOLE_NUMBER_DIGITS = 18
"""Bigger than any whole number a field takes, and small enough that `int()` stays cheap."""


# -- Field rules -----------------------------------------------------------------------------------
# Each raises an error whose type is the import's own issue code, so translating it is a lookup.


def _text(value: object) -> str:
    if not isinstance(value, str):
        raise PydanticCustomError("wrong_type", "Expected text.")
    stripped = value.strip()
    if not stripped:
        raise PydanticCustomError(
            "invalid_value", "Must not be blank; leave an optional field out."
        )
    if "\x00" in stripped:
        raise PydanticCustomError("invalid_value", "Must not contain a NUL character.")
    return stripped


def _whole_number(value: object) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, Decimal):
        if value.adjusted() >= MAX_WHOLE_NUMBER_DIGITS:
            raise PydanticCustomError("invalid_value", "Too large to be used here.")
        if value == value.to_integral_value():
            return int(value)
    raise PydanticCustomError("wrong_type", "Expected a whole number.")


def _number(value: object) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        raise PydanticCustomError("wrong_type", "Expected a number.")
    return Decimal(value)


def _priority(value: object) -> PlannedPriority:
    for priority in PRIORITIES:
        if value == priority:
            return priority
    raise PydanticCustomError("invalid_value", f"Priority must be one of {', '.join(PRIORITIES)}.")


def _operation_name(value: object) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise PydanticCustomError("wrong_type", "Expected the name of an operation in this job.")


def _a_list_if_stated(value: object) -> object:
    if value is None:
        raise PydanticCustomError("wrong_type", "Expected a list.")
    return value


def _at_least_one(message: str) -> AfterValidator:
    def check(items: list[Any]) -> list[Any]:
        if not items:
            raise PydanticCustomError("invalid_value", message)
        return items

    return AfterValidator(check)


type _Text = Annotated[str, BeforeValidator(_text)]
type _OptionalText = Annotated[str | None, BeforeValidator(_text)]
type _WholeNumber = Annotated[int, BeforeValidator(_whole_number)]
type _OptionalNumber = Annotated[Decimal | None, BeforeValidator(_number)]
type _OperationName = Annotated[str, BeforeValidator(_operation_name)]


# -- The file --------------------------------------------------------------------------------------


class _FileObject(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class _Route(_FileObject):
    machine: _Text
    duration: _WholeNumber
    energy: _OptionalNumber = None


class _Operation(_FileObject):
    name: _Text
    routes: Annotated[
        list[_Route], _at_least_one("An operation needs at least one machine it can run on.")
    ]
    after: Annotated[list[_OperationName] | None, BeforeValidator(_a_list_if_stated)] = None


class _Job(_FileObject):
    name: _Text
    priority: Annotated[PlannedPriority, BeforeValidator(_priority)] = "med"
    operations: Annotated[
        list[_Operation], _at_least_one("A job must have at least one operation.")
    ]


class _Machine(_FileObject):
    name: _Text
    category: _OptionalText = None
    salary: _OptionalNumber = None


class _File(_FileObject):
    format: Literal["floorsync"]
    version: _WholeNumber
    machines: list[_Machine] = Field(default_factory=list)
    jobs: Annotated[list[_Job], _at_least_one("A file must list at least one job.")]


def read_floorsync_file(document: Mapping[str, object]) -> ReadFileResult:
    """Read a FloorSync document into a plan, or report every problem in its shape at once."""

    try:
        version = _whole_number(document["version"]) if "version" in document else None
    except PydanticCustomError:
        version = None  # Reported with everything else below.
    if version is not None and version != FLOORSYNC_VERSION:
        # Nothing else in a file of another version can be trusted to mean the same thing.
        return FileUnreadable(
            issues=(
                ImportIssue(
                    "unsupported_version",
                    f"The file is FloorSync format version {version}; this FloorSync reads "
                    f"version {FLOORSYNC_VERSION}.",
                ),
            )
        )

    try:
        file = _File.model_validate(document)
    except ValidationError as error:
        return FileUnreadable(issues=tuple(_issue(detail) for detail in error.errors()))
    return PlanRead(plan=_plan(file))


def _plan(file: _File) -> ImportPlan:
    return ImportPlan(
        format="floorsync",
        machines=tuple(
            PlannedMachine(
                name=machine.name,
                category=machine.category,
                salary=machine.salary,
                location=f"machines[{index}]",
            )
            for index, machine in enumerate(file.machines)
        ),
        jobs=tuple(_planned_job(job, f"jobs[{index}]") for index, job in enumerate(file.jobs)),
    )


def _planned_job(job: _Job, location: str) -> PlannedJob:
    operations: list[PlannedOperation] = []
    for index, operation in enumerate(job.operations):
        at = f"{location}.operations[{index}]"
        operations.append(
            PlannedOperation(
                name=operation.name,
                routes=tuple(
                    PlannedRoute(
                        machine=route.machine,
                        duration=route.duration,
                        energy=route.energy,
                        location=f"{at}.routes[{position}]",
                    )
                    for position, route in enumerate(operation.routes)
                ),
                after=None if operation.after is None else tuple(operation.after),
                location=at,
            )
        )
    return PlannedJob(
        name=job.name, priority=job.priority, operations=tuple(operations), location=location
    )


# -- Validation errors to import issues ------------------------------------------------------------


def _issue(detail: ErrorDetails) -> ImportIssue:
    path = detail["loc"]
    location = _location(path) or None
    match detail["type"]:
        case "missing":
            return ImportIssue("missing_field", f"{path[-1]!r} is required.", location)
        case "extra_forbidden":
            allowed = ", ".join(sorted(_object_at(path[:-1]).model_fields))
            return ImportIssue(
                "unknown_field",
                f"{path[-1]!r} is not a field here. Allowed: {allowed}.",
                location,
            )
        case "model_type" | "model_attributes_type" | "dict_type":
            return ImportIssue("wrong_type", "Expected an object.", location)
        case "list_type":
            return ImportIssue("wrong_type", "Expected a list.", location)
        case "wrong_type":
            return ImportIssue("wrong_type", detail["msg"], location)
        case _:
            return ImportIssue("invalid_value", detail["msg"], location)


def _location(path: Sequence[int | str]) -> str:
    """`("jobs", 2, "operations", 0)` as the file location `jobs[2].operations[0]`."""

    location = ""
    for segment in path:
        if isinstance(segment, int):
            location += f"[{segment}]"
        else:
            location += f".{segment}" if location else segment
    return location


def _object_at(path: Sequence[int | str]) -> type[BaseModel]:
    """The model of the object at `path`, for naming the fields it allows."""

    model: type[BaseModel] = _File
    for segment in path:
        if isinstance(segment, str):
            model = _element_model(model.model_fields[segment].annotation)
    return model


def _element_model(annotation: object) -> type[BaseModel]:
    """`list[_Job] | None` and the like, down to `_Job`."""

    while get_origin(annotation) in (list, Union, UnionType):
        annotation = next(arg for arg in get_args(annotation) if arg is not type(None))
    if not (isinstance(annotation, type) and issubclass(annotation, BaseModel)):
        raise TypeError(f"No file object is declared at {annotation!r}.")
    return annotation
