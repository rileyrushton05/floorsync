"""A schedule resolved to concrete start and end times, queryable by instant.

Playback never reads a :class:`~floorsync_common.simulation.schedule.Schedule`
directly. It asks a timeline what is true at time ``t``.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, field

from .instance import Operation
from .state import JobState, JobStatus, MachineState, MachineStatus


@dataclass(frozen=True, slots=True)
class ScheduledOperation:
    """An operation placed on the clock: the unit a Gantt bar is drawn from.

    Attributes:
        operation: The underlying operation from the instance.
        start_time: Time processing begins.
        end_time: Time processing ends, equal to ``start_time + duration``.
        machine_slot: Zero-based position of this operation in its machine's
            execution sequence.
    """

    operation: Operation
    start_time: int
    end_time: int
    machine_slot: int

    @property
    def job(self) -> int:
        """Return the identifier of the job this operation belongs to."""
        return self.operation.job

    @property
    def machine(self) -> int:
        """Return the identifier of the machine processing this operation."""
        return self.operation.machine

    @property
    def duration(self) -> int:
        """Return the processing time of this operation."""
        return self.operation.duration

    @property
    def operation_index(self) -> int:
        """Return this operation's position within its job's precedence chain."""
        return self.operation.operation_index

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
    _by_machine: dict[int, tuple[ScheduledOperation, ...]] = field(repr=False, compare=False)
    _by_job: dict[int, tuple[ScheduledOperation, ...]] = field(repr=False, compare=False)
    _starts: tuple[int, ...] = field(repr=False, compare=False)

    @classmethod
    def from_operations(cls, operations: list[ScheduledOperation]) -> Timeline:
        """Index a list of scheduled operations into a queryable timeline.

        Args:
            operations: Scheduled operations in any order.

        Returns:
            The indexed timeline.
        """
        ordered = tuple(sorted(operations, key=lambda item: (item.start_time, item.machine)))

        by_machine: dict[int, list[ScheduledOperation]] = {}
        by_job: dict[int, list[ScheduledOperation]] = {}
        for item in ordered:
            by_machine.setdefault(item.machine, []).append(item)
            by_job.setdefault(item.job, []).append(item)

        for items in by_job.values():
            items.sort(key=lambda item: item.operation_index)

        return cls(
            operations=ordered,
            makespan=max((item.end_time for item in ordered), default=0),
            _by_machine={key: tuple(value) for key, value in by_machine.items()},
            _by_job={key: tuple(value) for key, value in by_job.items()},
            _starts=tuple(item.start_time for item in ordered),
        )

    def active_at(self, time: float) -> tuple[ScheduledOperation, ...]:
        """Return every operation processing at ``time``.

        Operations are ordered by start time. The scan is bounded by a binary
        search on start times, so a frame costs far less than a full pass once
        an instance grows past the small benchmark families.
        """
        cutoff = bisect_right(self._starts, time)
        return tuple(item for item in self.operations[:cutoff] if item.is_active_at(time))

    def operations_for_machine(self, machine_id: int) -> tuple[ScheduledOperation, ...]:
        """Return a machine's operations in execution order."""
        return self._by_machine.get(machine_id, ())

    def operations_for_job(self, job_id: int) -> tuple[ScheduledOperation, ...]:
        """Return a job's operations in precedence order."""
        return self._by_job.get(job_id, ())

    def machine_status_at(self, machine_id: int, time: float) -> MachineState:
        """Return what a machine is doing at ``time``.

        Utilization is busy time so far divided by elapsed time, so it reads as
        a running efficiency figure rather than a whole-run average.
        """
        items = self.operations_for_machine(machine_id)
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
            machine_id=machine_id,
            status=MachineStatus.BUSY if current is not None else MachineStatus.IDLE,
            current=current,
            utilization=0.0 if time <= 0 else min(1.0, busy_elapsed / time),
            completed_count=completed,
            remaining_count=len(items) - completed,
        )

    def job_status_at(self, job_id: int, time: float) -> JobState:
        """Return how far a job has progressed at ``time``."""
        items = self.operations_for_job(job_id)
        if not items:
            return JobState(
                job_id=job_id,
                status=JobStatus.DONE,
                current_op_index=None,
                current=None,
                completion_time=None,
                completed_count=0,
                total_count=0,
            )

        current: ScheduledOperation | None = None
        completed = 0
        next_pending: ScheduledOperation | None = None

        for item in items:
            if item.is_active_at(time):
                current = item
            elif item.end_time <= time:
                completed += 1
            elif next_pending is None:
                next_pending = item

        finish = items[-1].end_time
        if completed == len(items):
            status = JobStatus.DONE
            op_index: int | None = None
        elif current is not None:
            status = JobStatus.RUNNING
            op_index = current.operation_index
        else:
            status = JobStatus.WAITING
            op_index = next_pending.operation_index if next_pending is not None else None

        return JobState(
            job_id=job_id,
            status=status,
            current_op_index=op_index,
            current=current,
            completion_time=finish if status is JobStatus.DONE else None,
            completed_count=completed,
            total_count=len(items),
        )

    @property
    def machine_ids(self) -> tuple[int, ...]:
        """Return every machine identifier in the timeline, ascending."""
        return tuple(sorted(self._by_machine))

    @property
    def job_ids(self) -> tuple[int, ...]:
        """Return every job identifier in the timeline, ascending."""
        return tuple(sorted(self._by_job))
