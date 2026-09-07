"""Read and validate solved schedules for benchmark instances.

A solution file states, for each machine, the order that machine works through jobs. That sequencing
is the decision a scheduler makes; everything else (which machine, how long) already comes from the
instance. Turning one into `schedule_entries` plus a `schedule_dependencies` cache is what gives the
simulation something to replay.

Nothing here touches the database.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from floorsync_common.seed.instances import SEED_DATA_DIRECTORY, BenchmarkInstance

DEFAULT_SOLUTION_DIRECTORY = SEED_DATA_DIRECTORY / "solutions"

_MACHINE_KEY = re.compile(r"^machine_(\d+)$")


class SolutionError(Exception):
    """A solution file is malformed, or does not describe the instance it claims to."""


@dataclass(frozen=True)
class BenchmarkSolution:
    """A solved schedule: the order each machine works through the jobs queued on it."""

    instance: str
    solver: str
    makespan: int | None
    machine_sequences: Mapping[int, tuple[int, ...]]

    @property
    def queue_edge_count(self) -> int:
        """Machine-queue precedence edges implied: one between each consecutive pair."""

        return sum(max(len(jobs) - 1, 0) for jobs in self.machine_sequences.values())


def find_solution(instance: str, directory: Path | None = None) -> BenchmarkSolution | None:
    """Return the first solution found for `instance`, or None if nothing solves it.

    Files are read in name order so the choice stays deterministic when more than one solver has
    produced a solution for the same instance.
    """

    search = directory or DEFAULT_SOLUTION_DIRECTORY
    if not search.is_dir():
        return None

    for path in sorted(search.glob("*.json")):
        try:
            payload = json.loads(path.read_text())
        except json.JSONDecodeError as error:
            raise SolutionError(f"{path.name} is not valid JSON: {error}") from error

        if not isinstance(payload, Sequence) or isinstance(payload, str | bytes):
            raise SolutionError(f"{path.name} must contain a JSON array of solutions")

        for entry in payload:
            if isinstance(entry, Mapping) and entry.get("instance") == instance:
                return parse_solution(entry)

    return None


def available_solutions(directory: Path | None = None) -> list[str]:
    """Instance names that have a solution available, alphabetically."""

    search = directory or DEFAULT_SOLUTION_DIRECTORY
    if not search.is_dir():
        return []

    solved: set[str] = set()
    for path in sorted(search.glob("*.json")):
        try:
            payload = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        if isinstance(payload, Sequence) and not isinstance(payload, str | bytes):
            solved.update(
                str(entry["instance"])
                for entry in payload
                if isinstance(entry, Mapping) and "instance" in entry
            )
    return sorted(solved)


def parse_solution(payload: Mapping[str, object]) -> BenchmarkSolution:
    """Validate one decoded solution entry."""

    instance = payload.get("instance")
    if not isinstance(instance, str) or not instance:
        raise SolutionError("solution is missing an 'instance' name")

    solver = payload.get("solver")
    if not isinstance(solver, str) or not solver:
        raise SolutionError(f"{instance}: solution is missing a 'solver' name")

    makespan = payload.get("makespan")
    if makespan is not None and (not isinstance(makespan, int) or isinstance(makespan, bool)):
        raise SolutionError(f"{instance}: 'makespan' must be an integer, found {makespan!r}")

    sequences: dict[int, tuple[int, ...]] = {}
    for key, value in payload.items():
        match = _MACHINE_KEY.match(key)
        if match is None:
            continue
        if not isinstance(value, Sequence) or isinstance(value, str | bytes):
            raise SolutionError(f"{instance}: {key!r} must be a list of job indices")
        jobs: list[int] = []
        for position, job in enumerate(value):
            if not isinstance(job, int) or isinstance(job, bool):
                raise SolutionError(
                    f"{instance}: {key}[{position}] must be an integer job index, found {job!r}"
                )
            jobs.append(job)
        sequences[int(match.group(1))] = tuple(jobs)

    if not sequences:
        raise SolutionError(f"{instance}: solution has no 'machine_N' sequences")

    return BenchmarkSolution(
        instance=instance,
        solver=solver,
        makespan=makespan,
        machine_sequences=sequences,
    )


def validate_against(solution: BenchmarkSolution, instance: BenchmarkInstance) -> None:
    """Check a solution actually sequences the instance it claims to.

    A solution names jobs, not operations, so it can only be applied when each job visits a machine
    at most once. Reentrant instances need a format that identifies the specific visit.
    """

    if solution.instance != instance.name:
        raise SolutionError(
            f"solution is for {solution.instance!r} but the instance is {instance.name!r}"
        )

    expected: dict[int, list[int]] = {}
    for operation in instance.operations:
        expected.setdefault(operation.machine, []).append(operation.job)

    for machine, jobs in sorted(expected.items()):
        if len(set(jobs)) != len(jobs):
            repeated = sorted({job for job in jobs if jobs.count(job) > 1})
            raise SolutionError(
                f"{instance.name}: machine {machine} is visited more than once by job(s) "
                f"{repeated}, so a job-order sequence cannot say which visit runs when. This "
                f"solution format only supports non-reentrant instances."
            )

    missing = sorted(set(expected) - set(solution.machine_sequences))
    if missing:
        raise SolutionError(f"{instance.name}: solution has no sequence for machine(s) {missing}")

    for machine, sequence in sorted(solution.machine_sequences.items()):
        queued = expected.get(machine)
        if queued is None:
            raise SolutionError(
                f"{instance.name}: solution sequences machine {machine}, which no operation uses"
            )
        if sorted(sequence) != sorted(queued):
            raise SolutionError(
                f"{instance.name}: machine {machine} sequence {list(sequence)} does not match the "
                f"jobs routed to it {sorted(queued)}"
            )
