"""The job shop problem definition, parsed from an instance document.

An instance says what work exists and the order each job must pass through
machines. It carries no timing and no sequencing decisions; those come from a
solved schedule.
"""

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Self

from .errors import InstanceFormatError


@dataclass(frozen=True, slots=True)
class Operation:
    """One unit of work: a job's step on a machine for a fixed duration.

    Attributes:
        job: Identifier of the job this operation belongs to.
        operation_index: Position within the job's precedence chain, from zero.
        machine: Identifier of the machine that must process this operation.
        duration: Processing time in the instance's abstract time units.
    """

    job: int
    operation_index: int
    machine: int
    duration: int

    @property
    def key(self) -> tuple[int, int]:
        """Return the ``(job, operation_index)`` pair identifying this operation."""
        return (self.job, self.operation_index)


@dataclass(frozen=True, slots=True)
class JobShopInstance:
    """A parsed instance document and the lookups the engine needs over it.

    Attributes:
        name: Instance name, such as ``ft06``.
        family: Short family code the instance belongs to, such as ``ft``.
        machine_count: Number of machines declared by the document.
        job_count: Number of jobs declared by the document.
        operations: Every operation, in document order. Operations of a single
            job appear in the order that job must execute them.
    """

    name: str
    family: str
    machine_count: int
    job_count: int
    operations: tuple[Operation, ...]
    _by_job: dict[int, tuple[Operation, ...]] = field(repr=False, compare=False)
    _by_machine: dict[int, tuple[Operation, ...]] = field(repr=False, compare=False)

    @classmethod
    def from_dict(cls, document: Mapping[str, Any]) -> Self:
        """Build an instance from an already-parsed instance document.

        Args:
            document: Mapping with instance metadata and a ``data`` sequence of
                operation records.

        Returns:
            The parsed instance.

        Raises:
            InstanceFormatError: If required fields are absent or malformed.
        """
        try:
            rows = document["data"]
        except KeyError as exc:
            raise InstanceFormatError("Instance document has no 'data' array.") from exc

        if not isinstance(rows, Sequence) or isinstance(rows, str | bytes):
            raise InstanceFormatError("Instance field 'data' must be an array of operations.")

        operations: list[Operation] = []
        for position, row in enumerate(rows):
            if not isinstance(row, Mapping):
                raise InstanceFormatError(f"Operation at position {position} is not an object.")
            try:
                operations.append(
                    Operation(
                        job=int(row["job"]),
                        operation_index=int(row["operation"]),
                        machine=int(row["machine"]),
                        duration=int(row["duration"]),
                    )
                )
            except KeyError as exc:
                raise InstanceFormatError(
                    f"Operation at position {position} is missing field {exc}."
                ) from exc
            except (TypeError, ValueError) as exc:
                raise InstanceFormatError(
                    f"Operation at position {position} has a non-numeric field."
                ) from exc

        by_job: dict[int, list[Operation]] = {}
        by_machine: dict[int, list[Operation]] = {}
        for operation in operations:
            by_job.setdefault(operation.job, []).append(operation)
            by_machine.setdefault(operation.machine, []).append(operation)

        return cls(
            name=str(document.get("instance", "unnamed")),
            family=str(document.get("family", "")),
            machine_count=int(document.get("machines", len(by_machine))),
            job_count=int(document.get("jobs", len(by_job))),
            operations=tuple(operations),
            _by_job={job: tuple(items) for job, items in by_job.items()},
            _by_machine={machine: tuple(items) for machine, items in by_machine.items()},
        )

    @classmethod
    def load_from_json(cls, path: Path | str) -> Self:
        """Read and parse an instance document from disk.

        Args:
            path: Path to an instance JSON file, such as
                ``instances/json/ft06.json``.

        Returns:
            The parsed instance.

        Raises:
            InstanceFormatError: If the file is not valid JSON or is malformed.
        """
        source = Path(path)
        try:
            document = json.loads(source.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise InstanceFormatError(f"{source} is not valid JSON: {exc}") from exc
        if not isinstance(document, Mapping):
            raise InstanceFormatError(f"{source} does not contain a JSON object.")
        return cls.from_dict(document)

    def operations_for_job(self, job_id: int) -> tuple[Operation, ...]:
        """Return a job's operations in the order it must execute them."""
        return self._by_job.get(job_id, ())

    def operations_for_machine(self, machine_id: int) -> tuple[Operation, ...]:
        """Return every operation routed to a machine, in document order.

        Document order is the order the operations were declared, not the order
        a schedule chooses to run them.
        """
        return self._by_machine.get(machine_id, ())

    def operation(self, job_id: int, operation_index: int) -> Operation:
        """Return one operation by job and position within that job.

        Raises:
            KeyError: If the job has no operation at that position.
        """
        for candidate in self.operations_for_job(job_id):
            if candidate.operation_index == operation_index:
                return candidate
        raise KeyError(f"Job {job_id} has no operation at index {operation_index}.")

    @property
    def job_ids(self) -> tuple[int, ...]:
        """Return every job identifier present, ascending."""
        return tuple(sorted(self._by_job))

    @property
    def machine_ids(self) -> tuple[int, ...]:
        """Return every machine identifier present, ascending."""
        return tuple(sorted(self._by_machine))

    @property
    def total_work(self) -> int:
        """Return the summed duration of every operation.

        This is the makespan of the worst possible schedule and therefore a safe
        upper bound on any timeline built from this instance.
        """
        return sum(operation.duration for operation in self.operations)
