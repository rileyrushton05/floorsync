"""Turn the bytes of an uploaded file into an `ImportPlan`, whatever format it is in.

Three formats are read, told apart by their content rather than a filename or content type:

- **FloorSync JSON** (`"format": "floorsync"`), the format a company's own data is written in. Its
  shape is checked field by field and every problem is reported with its path, so a person fixing a
  hand-written file sees everything wrong in one go.
- **ScheduleOpt classic job shop** and **flexible job shop**, the benchmark files the seed loader
  already reads. Those parsers are reused unchanged; they stop at the first problem, which is fine
  for files that come from an upstream benchmark set rather than from a person.

Only the shape of the file is judged here. Whether its values make sense (a positive duration, a
precedence graph without a cycle) is `checks`, and whether its machines exist is `service`.
Nothing here touches the database.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import NoReturn, cast

from floorsync_common.imports.plan import (
    ImportIssue,
    ImportIssueCode,
    ImportPlan,
    PlannedJob,
    PlannedMachine,
    PlannedOperation,
    PlannedPriority,
    PlannedRoute,
)
from floorsync_common.imports.results import FileUnreadable, PlanRead, ReadFileResult
from floorsync_common.seed.flexible import (
    FlexibleInstance,
    is_flexible_payload,
    parse_flexible_instance,
)
from floorsync_common.seed.instances import BenchmarkInstance, InstanceError, parse_instance

FLOORSYNC_FORMAT = "floorsync"
FLOORSYNC_VERSION = 1
PRIORITIES: tuple[PlannedPriority, ...] = ("high", "med", "low")


class _DuplicateKey(Exception):
    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key


class _NonFiniteNumber(ValueError):
    pass


def read_import_file(raw: bytes) -> ReadFileResult:
    """Decode an uploaded file and translate it into a plan, or say why it cannot be."""

    if not raw.strip():
        return _unreadable("empty_file", "The file is empty.")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return _unreadable("not_utf8", "The file is not UTF-8 text.")

    try:
        document = json.loads(
            text,
            # Exact decimals for energy and salary, never binary floats (docs/api-conventions.md).
            parse_float=Decimal,
            parse_constant=_reject_non_finite,
            object_pairs_hook=_object_without_duplicate_keys,
        )
    except _DuplicateKey as error:
        return _unreadable(
            "duplicate_key",
            f"The key {error.key!r} appears twice in one object, so it is unclear which value "
            "was meant.",
        )
    except json.JSONDecodeError as error:
        return _unreadable(
            "not_json",
            f"The file is not valid JSON: {error.msg} (line {error.lineno}, column {error.colno}).",
        )
    except _NonFiniteNumber:
        return _unreadable("not_json", "The file uses NaN or Infinity, which are not JSON numbers.")
    except ValueError as error:
        # Python's own limits, such as an integer literal thousands of digits long.
        return _unreadable("not_json", f"The file is not valid JSON: {error}.")
    except RecursionError:
        return _unreadable("too_deeply_nested", "The file nests too deeply to read.")

    if not isinstance(document, dict):
        return _unreadable(
            "not_an_object", "The file must contain one JSON object, not a list or a value."
        )

    if document.get("format") == FLOORSYNC_FORMAT:
        return _FloorSyncReader().read(document)
    if is_flexible_payload(document):
        return _read_benchmark(document, flexible=True)
    if "data" in document:
        return _read_benchmark(document, flexible=False)
    return _unreadable(
        "unknown_format",
        'The file is not a format FloorSync imports. A FloorSync file starts with "format": '
        f'"{FLOORSYNC_FORMAT}" and "version": {FLOORSYNC_VERSION}; a benchmark file is a '
        "ScheduleOpt job-shop or flexible job-shop instance.",
    )


def _unreadable(code: ImportIssueCode, message: str) -> FileUnreadable:
    return FileUnreadable(issues=(ImportIssue(code, message),))


def _reject_non_finite(constant: str) -> NoReturn:
    raise _NonFiniteNumber(constant)


def _object_without_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    document: dict[str, object] = {}
    for key, value in pairs:
        if key in document:
            raise _DuplicateKey(key)
        document[key] = value
    return document


# -- Benchmarks ------------------------------------------------------------------------------------


def _read_benchmark(document: Mapping[str, object], *, flexible: bool) -> ReadFileResult:
    try:
        if flexible:
            return PlanRead(plan=_plan_from_flexible(parse_flexible_instance(document)))
        return PlanRead(plan=_plan_from_jobshop(parse_instance(document)))
    except InstanceError as error:
        kind = "flexible job-shop" if flexible else "job-shop"
        return _unreadable(
            "invalid_benchmark", f"The file is not a valid {kind} instance: {error}."
        )


def _digits(largest: int) -> int:
    """Digits needed for the largest label, so generated names sort correctly as text."""

    return len(str(max(largest, 0)))


def _plan_from_jobshop(instance: BenchmarkInstance) -> ImportPlan:
    """A classic instance: every job a straight chain, every operation on exactly one machine.

    Machine names match the seed loader's (`abz5/M3`), so importing an instance the database was
    seeded with reuses its machines. Jobs carry the instance name too (`abz5/J7`), since a floor
    can hold jobs from several imports. A declared job with no operations is left out: there is
    nothing to schedule in it.
    """

    machine_width = _digits(instance.machine_count - 1)
    machine_names = [
        f"{instance.name}/M{index:0{machine_width}d}" for index in range(instance.machine_count)
    ]
    job_width = _digits(instance.job_count - 1)

    jobs: list[PlannedJob] = []
    for job, operations in instance.operations_by_job.items():
        if not operations:
            continue
        operation_width = _digits(len(operations) - 1)
        jobs.append(
            PlannedJob(
                name=f"{instance.name}/J{job:0{job_width}d}",
                priority="med",
                operations=tuple(
                    PlannedOperation(
                        name=f"Op{operation.index:0{operation_width}d}",
                        routes=(
                            PlannedRoute(
                                machine=machine_names[operation.machine],
                                duration=operation.duration,
                                energy=None,
                                location=f"data (job {job}, operation {operation.index})",
                            ),
                        ),
                        # The file's only precedence is operation order, which is list order here.
                        after=None,
                        location=f"data (job {job}, operation {operation.index})",
                    )
                    for operation in operations
                ),
                location=f"data (job {job})",
            )
        )

    return ImportPlan(
        format="jobshop",
        machines=tuple(
            PlannedMachine(name=name, category=None, salary=None, location="machines")
            for name in machine_names
        ),
        jobs=tuple(jobs),
    )


def _plan_from_flexible(instance: FlexibleInstance) -> ImportPlan:
    """A flexible instance: several candidate machines per operation, explicit precedence edges.

    Every operation's predecessors are stated, even when there are none, because this format's
    edges are the precedence: a job can branch, so list order means nothing.
    """

    machine_width = _digits(max(instance.machine_labels, default=0))
    machine_names = {
        label: f"{instance.name}/M{label:0{machine_width}d}" for label in instance.machine_labels
    }
    job_width = _digits(max(instance.job_labels, default=0))
    operation_width = _digits(max((operation.id for operation in instance.operations), default=0))

    def operation_name(operation_id: int) -> str:
        return f"Op{operation_id:0{operation_width}d}"

    predecessors: dict[int, list[int]] = {}
    for before, after in instance.dependencies:
        predecessors.setdefault(after, []).append(before)

    jobs = tuple(
        PlannedJob(
            name=f"{instance.name}/J{job:0{job_width}d}",
            priority="med",
            operations=tuple(
                PlannedOperation(
                    name=operation_name(operation.id),
                    routes=tuple(
                        PlannedRoute(
                            machine=machine_names[candidate.machine],
                            duration=candidate.duration,
                            energy=None,
                            location=(
                                f"operations (operation {operation.id}, "
                                f"machine {candidate.machine})"
                            ),
                        )
                        for candidate in operation.candidates
                    ),
                    after=tuple(
                        operation_name(before) for before in predecessors.get(operation.id, ())
                    ),
                    location=f"operations (operation {operation.id})",
                )
                for operation in operations
            ),
            location=f"precedences (job {job})",
        )
        for job, operations in instance.operations_by_job.items()
    )

    return ImportPlan(
        format="flexible-jobshop",
        machines=tuple(
            PlannedMachine(name=name, category=None, salary=None, location="operations")
            for name in machine_names.values()
        ),
        jobs=jobs,
    )


# -- FloorSync JSON --------------------------------------------------------------------------------


class _FloorSyncReader:
    """Read a FloorSync document field by field, collecting every structural problem.

    A field with the wrong shape is reported and treated as absent, so reading carries on and the
    next problem is found too. The plan is only returned when there were none at all: a plan built
    around a hole would make the later checks report problems that are really the same one.
    """

    def __init__(self) -> None:
        self.issues: list[ImportIssue] = []

    def read(self, document: Mapping[str, object]) -> ReadFileResult:
        fields = self._fields(
            document, "", required=("format", "version", "jobs"), optional=("machines",)
        )
        version = self._whole_number(fields, "version", "")
        if version is not None and version != FLOORSYNC_VERSION:
            # Nothing else in a file of another version can be trusted to mean the same thing.
            return _unreadable(
                "unsupported_version",
                f"The file is FloorSync format version {version}; this FloorSync reads version "
                f"{FLOORSYNC_VERSION}.",
            )

        machines = tuple(
            machine
            for index, item in enumerate(self._list(fields, "machines", ""))
            if (machine := self._machine(item, f"machines[{index}]")) is not None
        )
        raw_jobs = self._list(fields, "jobs", "", at_least_one="A file must list at least one job.")
        jobs = tuple(
            job
            for index, item in enumerate(raw_jobs)
            if (job := self._job(item, f"jobs[{index}]")) is not None
        )

        if self.issues:
            return FileUnreadable(issues=tuple(self.issues))
        return PlanRead(plan=ImportPlan(format="floorsync", machines=machines, jobs=jobs))

    def _machine(self, item: object, location: str) -> PlannedMachine | None:
        fields = self._fields(item, location, required=("name",), optional=("category", "salary"))
        name = self._text(fields, "name", location)
        category = self._text(fields, "category", location)
        salary = self._decimal(fields, "salary", location)
        if name is None:
            return None
        return PlannedMachine(name=name, category=category, salary=salary, location=location)

    def _job(self, item: object, location: str) -> PlannedJob | None:
        fields = self._fields(
            item, location, required=("name", "operations"), optional=("priority",)
        )
        name = self._text(fields, "name", location)
        priority = self._priority(fields, location)
        raw_operations = self._list(
            fields, "operations", location, at_least_one="A job must have at least one operation."
        )
        operations = tuple(
            operation
            for index, raw in enumerate(raw_operations)
            if (operation := self._operation(raw, f"{location}.operations[{index}]")) is not None
        )
        if name is None:
            return None
        return PlannedJob(name=name, priority=priority, operations=operations, location=location)

    def _operation(self, item: object, location: str) -> PlannedOperation | None:
        fields = self._fields(item, location, required=("name", "routes"), optional=("after",))
        name = self._text(fields, "name", location)
        after = self._operation_names(fields, "after", location)
        raw_routes = self._list(
            fields,
            "routes",
            location,
            at_least_one="An operation needs at least one machine it can run on.",
        )
        routes = tuple(
            route
            for index, raw in enumerate(raw_routes)
            if (route := self._route(raw, f"{location}.routes[{index}]")) is not None
        )
        if name is None:
            return None
        return PlannedOperation(name=name, routes=routes, after=after, location=location)

    def _route(self, item: object, location: str) -> PlannedRoute | None:
        fields = self._fields(
            item, location, required=("machine", "duration"), optional=("energy",)
        )
        machine = self._text(fields, "machine", location)
        duration = self._whole_number(fields, "duration", location)
        energy = self._decimal(fields, "energy", location)
        if machine is None or duration is None:
            return None
        return PlannedRoute(machine=machine, duration=duration, energy=energy, location=location)

    # -- Field readers. Each reports its own problem and returns None for a missing or bad value.

    def _fields(
        self,
        item: object,
        location: str,
        *,
        required: Sequence[str],
        optional: Sequence[str],
    ) -> Mapping[str, object]:
        if not isinstance(item, dict):
            self._problem("wrong_type", "Expected an object.", location or None)
            return {}
        fields = cast(dict[str, object], item)
        for key in required:
            if key not in fields:
                self._problem("missing_field", f"{key!r} is required.", _child(location, key))
        allowed = set(required) | set(optional)
        for key in fields:
            if key not in allowed:
                self._problem(
                    "unknown_field",
                    f"{key!r} is not a field here. Allowed: {', '.join(sorted(allowed))}.",
                    _child(location, key),
                )
        return fields

    def _text(self, fields: Mapping[str, object], key: str, location: str) -> str | None:
        if key not in fields:
            return None
        value = fields[key]
        path = _child(location, key)
        if not isinstance(value, str):
            self._problem("wrong_type", "Expected text.", path)
            return None
        stripped = value.strip()
        if not stripped:
            self._problem("invalid_value", "Must not be blank; leave an optional field out.", path)
            return None
        if "\x00" in stripped:
            self._problem("invalid_value", "Must not contain a NUL character.", path)
            return None
        return stripped

    def _whole_number(self, fields: Mapping[str, object], key: str, location: str) -> int | None:
        if key not in fields:
            return None
        value = fields[key]
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        if isinstance(value, Decimal) and value == value.to_integral_value():
            return int(value)
        self._problem("wrong_type", "Expected a whole number.", _child(location, key))
        return None

    def _decimal(self, fields: Mapping[str, object], key: str, location: str) -> Decimal | None:
        if key not in fields:
            return None
        value = fields[key]
        if isinstance(value, int) and not isinstance(value, bool):
            return Decimal(value)
        if isinstance(value, Decimal):
            return value
        self._problem("wrong_type", "Expected a number.", _child(location, key))
        return None

    def _priority(self, fields: Mapping[str, object], location: str) -> PlannedPriority:
        if "priority" not in fields:
            return "med"
        value = fields["priority"]
        for priority in PRIORITIES:
            if value == priority:
                return priority
        self._problem(
            "invalid_value",
            f"Priority must be one of {', '.join(PRIORITIES)}.",
            _child(location, "priority"),
        )
        return "med"

    def _list(
        self,
        fields: Mapping[str, object],
        key: str,
        location: str,
        *,
        at_least_one: str | None = None,
    ) -> list[object]:
        if key not in fields:
            return []
        value = fields[key]
        if not isinstance(value, list):
            self._problem("wrong_type", "Expected a list.", _child(location, key))
            return []
        if not value and at_least_one is not None:
            self._problem("invalid_value", at_least_one, _child(location, key))
        return cast(list[object], value)

    def _operation_names(
        self, fields: Mapping[str, object], key: str, location: str
    ) -> tuple[str, ...] | None:
        """The names in an `after` list. `None` when the field is absent: "not stated"."""

        if key not in fields:
            return None
        names: list[str] = []
        for index, value in enumerate(self._list(fields, key, location)):
            if isinstance(value, str) and value.strip():
                names.append(value.strip())
            else:
                self._problem(
                    "wrong_type",
                    "Expected the name of an operation in this job.",
                    f"{_child(location, key)}[{index}]",
                )
        return tuple(names)

    def _problem(self, code: ImportIssueCode, message: str, location: str | None) -> None:
        self.issues.append(ImportIssue(code, message, location))


def _child(location: str, key: str) -> str:
    return f"{location}.{key}" if location else key
