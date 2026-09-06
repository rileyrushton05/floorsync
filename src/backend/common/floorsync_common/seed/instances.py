"""Read and validate job-shop benchmark instance files.

Nothing here touches the database. Parsing is separated from loading so the file format can be
validated -- and tested -- without a running PostgreSQL.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

_REPOSITORY_SOURCE_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_INSTANCE_DIRECTORY = _REPOSITORY_SOURCE_ROOT / "database" / "seed-data" / "jobshop"


class InstanceError(Exception):
    """A benchmark instance file is missing, malformed, or internally inconsistent."""


@dataclass(frozen=True, slots=True)
class BenchmarkOperation:
    """One step of one job: run on `machine` for `duration`, after the step before it."""

    job: int
    index: int
    machine: int
    duration: int


@dataclass(frozen=True)
class BenchmarkInstance:
    """A parsed, validated job-shop problem.

    `job_count` and `machine_count` are the instance's own declared totals rather than the distinct
    indices seen in `operations`; an instance may legitimately declare a machine that no operation
    happens to use.
    """

    name: str
    family: str
    job_count: int
    machine_count: int
    operations: tuple[BenchmarkOperation, ...]

    @cached_property
    def operations_by_job(self) -> Mapping[int, tuple[BenchmarkOperation, ...]]:
        """Operations grouped by job, each in execution order."""

        grouped: dict[int, list[BenchmarkOperation]] = {job: [] for job in range(self.job_count)}
        for operation in self.operations:
            grouped[operation.job].append(operation)
        return {job: tuple(sorted(items, key=lambda o: o.index)) for job, items in grouped.items()}

    @property
    def dependency_count(self) -> int:
        """Precedence edges implied by operation order: one fewer than each job's operations."""

        return sum(max(len(items) - 1, 0) for items in self.operations_by_job.values())


def available_instances(directory: Path | None = None) -> list[str]:
    """Names of every instance file that can be loaded, alphabetically."""

    search = directory or DEFAULT_INSTANCE_DIRECTORY
    if not search.is_dir():
        return []
    return sorted(path.stem for path in search.glob("*.json"))


def load_instance(name: str, directory: Path | None = None) -> BenchmarkInstance:
    """Read and validate the named instance file."""

    search = directory or DEFAULT_INSTANCE_DIRECTORY
    path = search / f"{name}.json"
    if not path.is_file():
        known = ", ".join(available_instances(search)) or "none found"
        raise InstanceError(f"unknown instance {name!r} (available: {known})")

    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise InstanceError(f"{path.name} is not valid JSON: {error}") from error

    if not isinstance(payload, dict):
        found = type(payload).__name__
        raise InstanceError(f"{path.name} must contain a JSON object, found {found}")

    return parse_instance(payload)


def parse_instance(payload: Mapping[str, object]) -> BenchmarkInstance:
    """Validate a decoded instance payload, or explain exactly why it cannot be used."""

    name = _require_str(payload, "instance")
    family = _require_str(payload, "family")
    job_count = _require_positive_int(payload, "jobs")
    machine_count = _require_positive_int(payload, "machines")

    raw_data = payload.get("data")
    if not isinstance(raw_data, Sequence) or isinstance(raw_data, str | bytes):
        raise InstanceError(f"{name}: 'data' must be a list of operations")
    if not raw_data:
        raise InstanceError(f"{name}: 'data' is empty")

    operations = tuple(
        _parse_operation(name, position, entry, job_count, machine_count)
        for position, entry in enumerate(raw_data)
    )
    _validate_operation_indices(name, operations)

    return BenchmarkInstance(
        name=name,
        family=family,
        job_count=job_count,
        machine_count=machine_count,
        operations=operations,
    )


def _parse_operation(
    instance: str,
    position: int,
    entry: object,
    job_count: int,
    machine_count: int,
) -> BenchmarkOperation:
    if not isinstance(entry, Mapping):
        raise InstanceError(f"{instance}: data[{position}] must be an object")

    job = _require_int(entry, "job", f"{instance}: data[{position}]")
    index = _require_int(entry, "operation", f"{instance}: data[{position}]")
    machine = _require_int(entry, "machine", f"{instance}: data[{position}]")
    duration = _require_int(entry, "duration", f"{instance}: data[{position}]")

    if not 0 <= job < job_count:
        raise InstanceError(
            f"{instance}: data[{position}] job {job} is outside the declared {job_count} jobs"
        )
    if not 0 <= machine < machine_count:
        raise InstanceError(
            f"{instance}: data[{position}] machine {machine} is outside the declared "
            f"{machine_count} machines"
        )
    if duration < 0:
        raise InstanceError(f"{instance}: data[{position}] duration {duration} is negative")

    return BenchmarkOperation(job=job, index=index, machine=machine, duration=duration)


def _validate_operation_indices(instance: str, operations: Sequence[BenchmarkOperation]) -> None:
    """Every job's operation indices must run 0..n-1 exactly once -- that ordering is the only
    precedence information the file carries, so a gap or a repeat makes the job unorderable."""

    seen: dict[int, list[int]] = {}
    for operation in operations:
        seen.setdefault(operation.job, []).append(operation.index)

    for job, indices in sorted(seen.items()):
        ordered = sorted(indices)
        if len(set(indices)) != len(indices):
            duplicates = sorted({index for index in indices if indices.count(index) > 1})
            raise InstanceError(f"{instance}: job {job} repeats operation index {duplicates}")
        if ordered != list(range(len(ordered))):
            raise InstanceError(
                f"{instance}: job {job} operation indices are not contiguous from 0 "
                f"(found {ordered[0]}..{ordered[-1]} across {len(ordered)} operations)"
            )


def _require_str(payload: Mapping[str, object], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise InstanceError(f"missing or empty {key!r}")
    return value


def _require_positive_int(payload: Mapping[str, object], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, str):
        try:
            value = int(value)
        except ValueError as error:
            raise InstanceError(f"{key!r} must be a positive integer, found {value!r}") from error
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise InstanceError(f"{key!r} must be a positive integer, found {value!r}")
    return value


def _require_int(entry: Mapping[str, object], key: str, context: str) -> int:
    value = entry.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise InstanceError(f"{context} {key!r} must be an integer, found {value!r}")
    return value
