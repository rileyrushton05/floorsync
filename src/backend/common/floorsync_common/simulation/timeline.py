"""A schedule resolved to concrete start and end times, queryable by instant.

Playback never reads schedule rows or a benchmark solution directly. It asks a
timeline what is true at time ``t``.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from .graph import PrecedenceEdge, TimelineNode, resolve_start_times
from .state import JobState, JobStatus, MachineState, MachineStatus


@dataclass(frozen=True, slots=True)
class ScheduledOperation:
    """A node placed on the clock: the unit a Gantt bar is drawn from.

    Attributes:
        node: The underlying unit of work.
        start_time: Time processing begins.
        end_time: Time processing ends, equal to ``start_time + duration``.
        machine_slot: Zero-based position of this operation in its machine's
            queue, derived from the resolved start times rather than stored.
    """

    node: TimelineNode
    start_time: int
    end_time: int
    machine_slot: int

    @property
    def key(self) -> str:
        """Return the identifier of this scheduled operation."""
        return self.node.key

    @property
    def job_key(self) -> str:
        """Return the identifier of the job this operation belongs to."""
        return self.node.job_key

    @property
    def machine_key(self) -> str:
        """Return the identifier of the machine processing this operation."""
        return self.node.machine_key

    @property
    def job_label(self) -> str:
        """Return the display name of the job."""
        return self.node.job_label

    @property
    def machine_label(self) -> str:
        """Return the display name of the machine."""
        return self.node.machine_label

    @property
    def operation_label(self) -> str:
        """Return the display name of this step."""
        return self.node.operation_label

    @property
    def duration(self) -> int:
        """Return the processing time of this operation."""
        return self.node.duration

    def is_active_at(self, time: float) -> bool:
        """Return whether the operation is processing at ``time``.

        The interval is half-open, so an operation ending exactly at ``time`` has
        already released its machine and an operation starting at ``time`` holds
        it. This keeps two consecutive operations on one machine from both
        appearing busy at the changeover instant.
        """
        return self.start_time <= time < self.end_time


@dataclass(frozen=True, slots=True)
class Timeline:
    """Every operation with resolved timing, indexed for playback queries.

    Attributes:
        operations: Every scheduled operation, ordered by start time.
        makespan: Time at which the last operation finishes.
    """

    operations: tuple[ScheduledOperation, ...]
    makespan: int
    _by_machine: dict[str, tuple[ScheduledOperation, ...]] = field(repr=False, compare=False)
    _by_job: dict[str, tuple[ScheduledOperation, ...]] = field(repr=False, compare=False)
    _machine_labels: dict[str, str] = field(repr=False, compare=False)
    _job_labels: dict[str, str] = field(repr=False, compare=False)
    _starts: tuple[int, ...] = field(repr=False, compare=False)

    @classmethod
    def from_graph(cls, nodes: Sequence[TimelineNode], edges: Iterable[PrecedenceEdge]) -> Timeline:
        """Resolve nodes and precedence edges into a timeline.

        This is the single entry point both schedule sources share: FloorSync
        schedules pass rows translated by
        :mod:`floorsync_common.simulation.floorsync`, benchmark instances pass
        edges derived by :mod:`floorsync_common.simulation.builder`.

        Args:
            nodes: Every unit of work to place.
            edges: Precedence constraints between those nodes.

        Returns:
            The indexed timeline.

        Raises:
            CyclicScheduleError: If the constraints imply a deadlock.
        """
        starts = resolve_start_times(nodes, edges)

        placed: list[ScheduledOperation] = []
        for node in nodes:
            start = starts[node.key]
            placed.append(
                ScheduledOperation(
                    node=node,
                    start_time=start,
                    end_time=start + node.duration,
                    machine_slot=0,
                )
            )
        return cls.from_operations(placed)

    @classmethod
    def from_operations(cls, operations: Sequence[ScheduledOperation]) -> Timeline:
        """Index scheduled operations, deriving each one's machine queue position.

        Two operations on one machine can never share a start time in a feasible
        schedule, so ordering a machine's operations by start time reproduces its
        queue exactly, and the position never has to be stored.
        """
        ordered = tuple(
            sorted(operations, key=lambda item: (item.start_time, item.machine_key, item.key))
        )

        by_machine: dict[str, list[ScheduledOperation]] = {}
        by_job: dict[str, list[ScheduledOperation]] = {}
        machine_labels: dict[str, str] = {}
        job_labels: dict[str, str] = {}
        for item in ordered:
            by_machine.setdefault(item.machine_key, []).append(item)
            by_job.setdefault(item.job_key, []).append(item)
            machine_labels.setdefault(item.machine_key, item.machine_label)
            job_labels.setdefault(item.job_key, item.job_label)

        slotted: dict[str, ScheduledOperation] = {}
        for items in by_machine.values():
            for slot, item in enumerate(items):
                slotted[item.key] = ScheduledOperation(
                    node=item.node,
                    start_time=item.start_time,
                    end_time=item.end_time,
                    machine_slot=slot,
                )

        final = tuple(slotted[item.key] for item in ordered)
        return cls(
            operations=final,
            makespan=max((item.end_time for item in final), default=0),
            _by_machine={
                key: tuple(slotted[item.key] for item in items) for key, items in by_machine.items()
            },
            _by_job={
                key: tuple(slotted[item.key] for item in items) for key, items in by_job.items()
            },
            _machine_labels=machine_labels,
            _job_labels=job_labels,
            _starts=tuple(item.start_time for item in final),
        )

    def active_at(self, time: float) -> tuple[ScheduledOperation, ...]:
        """Return every operation processing at ``time``.

        Operations are ordered by start time. The scan is bounded by a binary
        search on start times, so a frame costs far less than a full pass once a
        schedule grows large.
        """
        cutoff = bisect_right(self._starts, time)
        return tuple(item for item in self.operations[:cutoff] if item.is_active_at(time))

    def operations_for_machine(self, machine_key: str) -> tuple[ScheduledOperation, ...]:
        """Return a machine's operations in queue order."""
        return self._by_machine.get(machine_key, ())

    def operations_for_job(self, job_key: str) -> tuple[ScheduledOperation, ...]:
        """Return a job's operations in start-time order."""
        return self._by_job.get(job_key, ())

    def machine_status_at(self, machine_key: str, time: float) -> MachineState:
        """Return what a machine is doing at ``time``.

        Utilization is busy time so far divided by elapsed time, so it reads as a
        running efficiency figure rather than a whole-run average.
        """
        items = self.operations_for_machine(machine_key)
        current: ScheduledOperation | None = None
        busy_elapsed = 0.0
        completed = 0

        for item in items:
            if item.is_active_at(time):
                current = item
                busy_elapsed += time - item.start_time
            elif item.end_time <= time:
                busy_elapsed += item.duration
                completed += 1

        return MachineState(
            machine_key=machine_key,
            machine_label=self._machine_labels.get(machine_key, machine_key),
            status=MachineStatus.BUSY if current is not None else MachineStatus.IDLE,
            current=current,
            utilization=0.0 if time <= 0 else min(1.0, busy_elapsed / time),
            completed_count=completed,
            remaining_count=len(items) - completed,
        )

    def job_status_at(self, job_key: str, time: float) -> JobState:
        """Return how far a job has progressed at ``time``."""
        items = self.operations_for_job(job_key)
        label = self._job_labels.get(job_key, job_key)
        if not items:
            return JobState(
                job_key=job_key,
                job_label=label,
                status=JobStatus.DONE,
                current=None,
                next_up=None,
                completion_time=None,
                completed_count=0,
                total_count=0,
            )

        current: ScheduledOperation | None = None
        next_up: ScheduledOperation | None = None
        completed = 0

        for item in items:
            if item.is_active_at(time):
                current = item
            elif item.end_time <= time:
                completed += 1
            elif next_up is None:
                next_up = item

        finish = max(item.end_time for item in items)
        if completed == len(items):
            status = JobStatus.DONE
        elif current is not None:
            status = JobStatus.RUNNING
        else:
            status = JobStatus.WAITING

        return JobState(
            job_key=job_key,
            job_label=label,
            status=status,
            current=current,
            next_up=None if status is JobStatus.RUNNING else next_up,
            completion_time=finish if status is JobStatus.DONE else None,
            completed_count=completed,
            total_count=len(items),
        )

    @property
    def machine_keys(self) -> tuple[str, ...]:
        """Return every machine identifier, ordered by display label."""
        return tuple(sorted(self._by_machine, key=lambda key: (self._machine_labels[key], key)))

    @property
    def job_keys(self) -> tuple[str, ...]:
        """Return every job identifier, ordered by display label."""
        return tuple(sorted(self._by_job, key=lambda key: (self._job_labels[key], key)))
