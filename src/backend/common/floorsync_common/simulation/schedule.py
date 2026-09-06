"""A solved schedule, parsed from a solver's solution document.

A schedule records the order in which jobs occupy each machine. It carries no
start or end times; those are derived by :mod:`floorsync_common.simulation.builder`
from this ordering plus the instance's job precedence.
"""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Self

from .errors import ScheduleFormatError

_MACHINE_KEY = re.compile(r"^machine_(\d+)$")


@dataclass(frozen=True, slots=True)
class Schedule:
    """One solver answer: the visiting order of jobs on every machine.

    Attributes:
        instance_name: Name of the instance this schedule solves.
        makespan: Makespan the solver reported, used to cross-check the timeline
            this schedule produces.
        solver: Name of the solver that produced the schedule.
        date: Date the solver ran, as recorded in the document.
        machine_sequences: Machine identifier to the job identifiers it
            processes, in execution order. A job appears more than once when it
            revisits that machine.
    """

    instance_name: str
    makespan: int | None
    solver: str
    date: str
    machine_sequences: Mapping[int, tuple[int, ...]]

    @classmethod
    def from_dict(cls, document: Mapping[str, Any]) -> Self:
        """Build a schedule from an already-parsed solution document.

        Args:
            document: Mapping with solution metadata and one ``machine_<id>``
                array per machine.

        Returns:
            The parsed schedule.

        Raises:
            ScheduleFormatError: If no machine sequences are present or a
                sequence is malformed.
        """
        sequences: dict[int, tuple[int, ...]] = {}
        for key, value in document.items():
            match = _MACHINE_KEY.match(str(key))
            if match is None:
                continue
            if not isinstance(value, list):
                raise ScheduleFormatError(f"Schedule field '{key}' must be an array of job ids.")
            try:
                sequences[int(match.group(1))] = tuple(int(job) for job in value)
            except (TypeError, ValueError) as exc:
                raise ScheduleFormatError(
                    f"Schedule field '{key}' contains a non-numeric job id."
                ) from exc

        if not sequences:
            raise ScheduleFormatError("Schedule document has no 'machine_<id>' sequences.")

        raw_makespan = document.get("makespan")
        return cls(
            instance_name=str(document.get("instance", "unnamed")),
            makespan=None if raw_makespan is None else int(raw_makespan),
            solver=str(document.get("solver", "")),
            date=str(document.get("date", "")),
            machine_sequences=sequences,
        )

    @classmethod
    def load_from_json(cls, path: Path | str, instance_name: str | None = None) -> Self:
        """Read a schedule from a solution file on disk.

        Solver runs write an array of solutions, one per instance solved, so a
        document holding several entries needs ``instance_name`` to pick one.

        Args:
            path: Path to a ``solutions_{solver}_{date}.json`` file.
            instance_name: Instance to select when the file holds several
                solutions. Required unless the file holds exactly one.

        Returns:
            The parsed schedule.

        Raises:
            ScheduleFormatError: If the file is malformed, or holds several
                solutions and ``instance_name`` does not identify one.
        """
        source = Path(path)
        try:
            document = json.loads(source.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ScheduleFormatError(f"{source} is not valid JSON: {exc}") from exc

        if isinstance(document, Mapping):
            return cls.from_dict(document)

        if not isinstance(document, list) or not document:
            raise ScheduleFormatError(f"{source} holds neither a solution object nor an array.")

        entries = [entry for entry in document if isinstance(entry, Mapping)]
        if instance_name is None:
            if len(entries) != 1:
                available = ", ".join(str(entry.get("instance", "?")) for entry in entries)
                raise ScheduleFormatError(
                    f"{source} holds {len(entries)} solutions; pass instance_name to select "
                    f"one of: {available}"
                )
            return cls.from_dict(entries[0])

        for entry in entries:
            if str(entry.get("instance")) == instance_name:
                return cls.from_dict(entry)
        raise ScheduleFormatError(f"{source} holds no solution for instance '{instance_name}'.")

    def sequence_for_machine(self, machine_id: int) -> tuple[int, ...]:
        """Return the job identifiers a machine processes, in execution order."""
        return self.machine_sequences.get(machine_id, ())

    @property
    def machine_ids(self) -> tuple[int, ...]:
        """Return every machine identifier this schedule sequences, ascending."""
        return tuple(sorted(self.machine_sequences))
