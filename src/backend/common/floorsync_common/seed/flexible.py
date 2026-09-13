"""Read and validate flexible job-shop (FJSP) benchmark instances.

The difference from a classic job-shop instance is that an operation lists *several* machines it
could run on, each with its own duration, so choosing the machine is part of the scheduling problem
rather than given. That maps onto several `compatibilities` rows for one operation -- the case the
schema was built for but the classic instances never exercise.

Two further differences shape the parser:

- Precedence is stated explicitly as before/after edges rather than implied by an operation's
  position in its job, so a job can be a branching assembly tree (several operations feeding one)
  instead of a straight chain.
- An operation carries no job of its own; its job comes from the precedence edges it appears in, and
  those job labels are not necessarily contiguous.

Nothing here touches the database.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

from floorsync_common.seed.instances import SEED_DATA_DIRECTORY, InstanceError

DEFAULT_FLEXIBLE_DIRECTORY = SEED_DATA_DIRECTORY / "flexible-jobshop"


@dataclass(frozen=True, slots=True)
class FlexibleCandidate:
    """One machine an operation could run on, and what it costs there."""

    machine: int
    duration: int


@dataclass(frozen=True, slots=True)
class FlexibleOperation:
    """One step of one job, with every machine that could perform it."""

    id: int
    job: int
    candidates: tuple[FlexibleCandidate, ...]


@dataclass(frozen=True)
class FlexibleInstance:
    """A parsed, validated flexible job-shop problem."""

    name: str
    family: str
    operations: tuple[FlexibleOperation, ...]
    dependencies: tuple[tuple[int, int], ...]

    @cached_property
    def operations_by_id(self) -> Mapping[int, FlexibleOperation]:
        return {operation.id: operation for operation in self.operations}

    @cached_property
    def job_labels(self) -> tuple[int, ...]:
        """Every job label present, ascending. Not necessarily contiguous or zero-based."""

        return tuple(sorted({operation.job for operation in self.operations}))

    @cached_property
    def machine_labels(self) -> tuple[int, ...]:
        """Every machine referenced by any candidate, ascending."""

        return tuple(
            sorted(
                {
                    candidate.machine
                    for operation in self.operations
                    for candidate in operation.candidates
                }
            )
        )

    @cached_property
    def operations_by_job(self) -> Mapping[int, tuple[FlexibleOperation, ...]]:
        grouped: dict[int, list[FlexibleOperation]] = {job: [] for job in self.job_labels}
        for operation in self.operations:
            grouped[operation.job].append(operation)
        return {job: tuple(sorted(items, key=lambda o: o.id)) for job, items in grouped.items()}

    @property
    def candidate_count(self) -> int:
        """Total operation/machine pairings -- one `compatibilities` row each."""

        return sum(len(operation.candidates) for operation in self.operations)


def available_flexible_instances(directory: Path | None = None) -> list[str]:
    """Names of every flexible instance file that can be loaded, alphabetically."""

    search = directory or DEFAULT_FLEXIBLE_DIRECTORY
    if not search.is_dir():
        return []
    return sorted(path.stem for path in search.glob("*.json"))


def load_flexible_instance(name: str, directory: Path | None = None) -> FlexibleInstance:
    """Read and validate the named flexible instance file."""

    search = directory or DEFAULT_FLEXIBLE_DIRECTORY
    path = search / f"{name}.json"
    if not path.is_file():
        known = ", ".join(available_flexible_instances(search)) or "none found"
        raise InstanceError(f"unknown flexible instance {name!r} (available: {known})")

    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise InstanceError(f"{path.name} is not valid JSON: {error}") from error

    if not isinstance(payload, dict):
        found = type(payload).__name__
        raise InstanceError(f"{path.name} must contain a JSON object, found {found}")

    return parse_flexible_instance(payload)


def is_flexible_payload(payload: Mapping[str, object]) -> bool:
    """Whether a decoded document is a flexible instance rather than a classic one.

    Keyed on structure rather than the file's own `format` field, which is the same string across
    every family upstream and so says nothing useful.
    """

    return "operations" in payload and "precedences" in payload


def parse_flexible_instance(payload: Mapping[str, object]) -> FlexibleInstance:
    """Validate a decoded flexible instance, or explain exactly why it cannot be used."""

    name = payload.get("instance")
    if not isinstance(name, str) or not name:
        raise InstanceError("missing or empty 'instance'")
    family = payload.get("family")
    family_name = family if isinstance(family, str) else ""

    rows = payload.get("operations")
    if not isinstance(rows, Sequence) or isinstance(rows, str | bytes):
        raise InstanceError(f"{name}: 'operations' must be a list")
    if not rows:
        raise InstanceError(f"{name}: 'operations' is empty")

    candidates: dict[int, list[FlexibleCandidate]] = {}
    for position, row in enumerate(rows):
        if not isinstance(row, Mapping):
            raise InstanceError(f"{name}: operations[{position}] must be an object")
        operation = _require_int(row, "operation", f"{name}: operations[{position}]")
        machine = _require_int(row, "machine", f"{name}: operations[{position}]")
        duration = _require_int(row, "duration", f"{name}: operations[{position}]")
        if duration < 0:
            raise InstanceError(f"{name}: operations[{position}] duration {duration} is negative")
        existing = candidates.setdefault(operation, [])
        if any(candidate.machine == machine for candidate in existing):
            raise InstanceError(
                f"{name}: operation {operation} lists machine {machine} more than once; a "
                f"compatibility can only be recorded once per operation and machine"
            )
        existing.append(FlexibleCandidate(machine=machine, duration=duration))

    labelled = _parse_precedences(name, payload, set(candidates))
    edges = tuple((before, after) for before, after, _ in labelled)
    job_of = _resolve_jobs(name, labelled, set(candidates))
    _reject_cycles(name, edges, set(candidates))

    operations = tuple(
        FlexibleOperation(
            id=operation,
            job=job_of[operation],
            candidates=tuple(sorted(items, key=lambda c: c.machine)),
        )
        for operation, items in sorted(candidates.items())
    )

    return FlexibleInstance(
        name=name,
        family=family_name,
        operations=operations,
        dependencies=edges,
    )


def _parse_precedences(
    name: str, payload: Mapping[str, object], known: set[int]
) -> tuple[tuple[int, int, int], ...]:
    """Validate the precedence edges, keeping each edge's job label."""

    raw = payload.get("precedences")
    if not isinstance(raw, Sequence) or isinstance(raw, str | bytes):
        raise InstanceError(f"{name}: 'precedences' must be a list")

    edges: list[tuple[int, int, int]] = []
    seen: set[tuple[int, int]] = set()
    for position, entry in enumerate(raw):
        if not isinstance(entry, Mapping):
            raise InstanceError(f"{name}: precedences[{position}] must be an object")
        before = _require_int(entry, "before", f"{name}: precedences[{position}]")
        after = _require_int(entry, "after", f"{name}: precedences[{position}]")
        job = _require_int(entry, "job", f"{name}: precedences[{position}]")
        for label, value in (("before", before), ("after", after)):
            if value not in known:
                raise InstanceError(
                    f"{name}: precedences[{position}] {label} references operation {value}, "
                    f"which has no entry in 'operations'"
                )
        if before == after:
            raise InstanceError(
                f"{name}: precedences[{position}] makes operation {before} depend on itself"
            )
        if (before, after) in seen:
            raise InstanceError(
                f"{name}: precedences[{position}] repeats the edge {before} -> {after}"
            )
        seen.add((before, after))
        edges.append((before, after, job))

    return tuple(edges)


def _resolve_jobs(
    name: str, edges: Sequence[tuple[int, int, int]], known: set[int]
) -> Mapping[int, int]:
    """Recover each operation's job from the precedence edges it appears in.

    An operation states no job of its own, so an operation in no edge at all -- a job of a single
    operation -- cannot be placed. That is rejected rather than guessed, because inventing a job
    would silently change the problem being loaded.
    """

    job_of: dict[int, int] = {}
    for before, after, job in edges:
        for operation in (before, after):
            existing = job_of.get(operation)
            if existing is not None and existing != job:
                raise InstanceError(
                    f"{name}: operation {operation} appears under job {existing} and job {job}; "
                    f"an operation belongs to exactly one job"
                )
            job_of[operation] = job

    orphaned = sorted(known - set(job_of))
    if orphaned:
        raise InstanceError(
            f"{name}: operation(s) {orphaned} appear in no precedence edge, so their job "
            f"cannot be determined. This format states an operation's job only through its "
            f"edges, so a job of a single operation cannot be expressed."
        )

    return job_of


def _reject_cycles(name: str, edges: Sequence[tuple[int, int]], known: set[int]) -> None:
    """A cyclic precedence graph describes work that can never start, so refuse it here.

    The classic format cannot express one (a job is a straight chain), but these edges are an
    arbitrary graph, so it has to be checked.
    """

    successors: dict[int, list[int]] = {operation: [] for operation in known}
    incoming: dict[int, int] = dict.fromkeys(known, 0)
    for before, after in edges:
        successors[before].append(after)
        incoming[after] += 1

    ready = [operation for operation, count in incoming.items() if count == 0]
    visited = 0
    while ready:
        operation = ready.pop()
        visited += 1
        for following in successors[operation]:
            incoming[following] -= 1
            if incoming[following] == 0:
                ready.append(following)

    if visited != len(known):
        stuck = sorted(operation for operation, count in incoming.items() if count > 0)
        raise InstanceError(
            f"{name}: precedence edges form a cycle involving operation(s) {stuck[:10]}"
        )


def _require_int(entry: Mapping[str, object], key: str, context: str) -> int:
    value = entry.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise InstanceError(f"{context} {key!r} must be an integer, found {value!r}")
    return value
