"""Turn the bytes of an uploaded file into an `ImportPlan`, whatever format it is in.

Three formats are read, told apart by their content rather than a filename or content type:

- **FloorSync JSON** (`"format": "floorsync"`), the format a company's own data is written in. Its
  shape is declared in `floorsync_file` and every problem is reported with its path, so a person
  fixing a hand-written file sees everything wrong in one go.
- **ScheduleOpt classic job shop** and **flexible job shop**, the benchmark files the seed loader
  already reads. Those parsers are reused unchanged; they stop at the first problem, which is fine
  for files that come from an upstream benchmark set rather than from a person.

Only the shape of the file is judged here. Whether its values make sense (a positive duration, a
precedence graph without a cycle) is `checks`, and whether its machines exist is `service`.
Nothing here touches the database.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from decimal import Decimal, DecimalException
from typing import NoReturn

from floorsync_common.imports.floorsync_file import (
    FLOORSYNC_FORMAT,
    FLOORSYNC_VERSION,
    read_floorsync_file,
)
from floorsync_common.imports.plan import (
    ImportIssue,
    ImportIssueCode,
    ImportPlan,
    PlannedJob,
    PlannedMachine,
    PlannedOperation,
    PlannedRoute,
)
from floorsync_common.imports.results import FileUnreadable, PlanRead, ReadFileResult
from floorsync_common.seed.flexible import (
    FlexibleInstance,
    is_flexible_payload,
    parse_flexible_instance,
)
from floorsync_common.seed.instances import BenchmarkInstance, InstanceError, parse_instance

# The request size limit bounds what a file lists, but not what a classic benchmark declares: a few
# bytes can say `"machines": 3000000`. These bound every format, far above any real floor (the
# largest committed benchmark has 792 jobs, 48 machines and 9,748 routes).
MAX_IMPORT_MACHINES = 1_000
MAX_IMPORT_JOBS = 10_000
MAX_IMPORT_ROWS = 100_000
"""Machines, jobs, operations and routes together."""


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
    except DecimalException:
        # `parse_float=Decimal` on a number like 1e999999999999999999999.
        return _unreadable("not_json", "The file contains a number too large to read.")
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
        return _within_limits(read_floorsync_file(document), machines="machines", jobs="jobs")
    if is_flexible_payload(document):
        return _within_limits(
            _read_benchmark(document, flexible=True), machines="operations", jobs="precedences"
        )
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


def _too_large(
    *, machines: int, jobs: int, rows: int, machines_at: str, jobs_at: str
) -> tuple[ImportIssue, ...]:
    issues: list[ImportIssue] = []
    if machines > MAX_IMPORT_MACHINES:
        issues.append(
            ImportIssue(
                "too_large",
                f"The file describes {machines:,} machines; one import can add at most "
                f"{MAX_IMPORT_MACHINES:,}.",
                machines_at,
            )
        )
    if jobs > MAX_IMPORT_JOBS:
        issues.append(
            ImportIssue(
                "too_large",
                f"The file describes {jobs:,} jobs; one import can add at most "
                f"{MAX_IMPORT_JOBS:,}.",
                jobs_at,
            )
        )
    if not issues and rows > MAX_IMPORT_ROWS:
        issues.append(
            ImportIssue(
                "too_large",
                f"The file describes {rows:,} machines, jobs, operations and routes; one import "
                f"can add at most {MAX_IMPORT_ROWS:,}.",
            )
        )
    return tuple(issues)


def _within_limits(read: ReadFileResult, *, machines: str, jobs: str) -> ReadFileResult:
    """Refuse a plan that is too large. Only for formats whose plan is no bigger than the file."""

    if not isinstance(read, PlanRead):
        return read
    plan = read.plan
    issues = _too_large(
        machines=len(plan.machines),
        jobs=len(plan.jobs),
        rows=len(plan.machines) + len(plan.jobs) + plan.operation_count + plan.route_count,
        machines_at=machines,
        jobs_at=jobs,
    )
    return FileUnreadable(issues=issues) if issues else read


def _read_benchmark(document: Mapping[str, object], *, flexible: bool) -> ReadFileResult:
    try:
        if flexible:
            return PlanRead(plan=_plan_from_flexible(parse_flexible_instance(document)))
        instance = parse_instance(document)
        # Bounded before expanding: the declared counts, unlike `data`, cost nothing to write.
        issues = _too_large(
            machines=instance.machine_count,
            jobs=instance.job_count,
            rows=instance.machine_count + instance.job_count + 2 * len(instance.operations),
            machines_at="machines",
            jobs_at="jobs",
        )
        if issues:
            return FileUnreadable(issues=issues)
        return PlanRead(plan=_plan_from_jobshop(instance))
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
