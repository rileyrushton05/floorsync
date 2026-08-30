"""Snapshots of what the floor looks like at one instant of simulated time.

Every value here is derived from a :class:`~floorsync_common.simulation.timeline.Timeline`
and a time value. Nothing in this module is mutated in place, so a snapshot can
be handed to a renderer and kept for comparison against a later one.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - import cycle guard for annotations only
    from .timeline import ScheduledOperation


class MachineStatus(StrEnum):
    """Whether a machine is processing an operation at the current instant."""

    IDLE = "idle"
    BUSY = "busy"


class JobStatus(StrEnum):
    """How far a job has progressed at the current instant."""

    WAITING = "waiting"
    RUNNING = "running"
    DONE = "done"


@dataclass(frozen=True, slots=True)
class MachineState:
    """What one machine is doing at the current instant.

    Attributes:
        machine_id: Identifier of the machine.
        status: Whether the machine is idle or processing.
        current: Operation being processed, or ``None`` when idle.
        utilization: Fraction of elapsed time the machine has spent processing,
            in ``[0.0, 1.0]``. Zero at time zero.
        completed_count: Number of operations the machine has finished.
        remaining_count: Number of operations the machine has yet to finish.
    """

    machine_id: int
    status: MachineStatus
    current: ScheduledOperation | None
    utilization: float
    completed_count: int
    remaining_count: int


@dataclass(frozen=True, slots=True)
class JobState:
    """How far one job has progressed at the current instant.

    Attributes:
        job_id: Identifier of the job.
        status: Whether the job is waiting, running or finished.
        current_op_index: Position of the operation in progress, or of the next
            operation due when the job is waiting. ``None`` once the job is done.
        current: Operation being processed, or ``None`` when not running.
        completion_time: End time of the job's final operation, or ``None``
            until the job is done.
        completed_count: Number of the job's operations already finished.
        total_count: Number of operations the job has in total.
    """

    job_id: int
    status: JobStatus
    current_op_index: int | None
    current: ScheduledOperation | None
    completion_time: int | None
    completed_count: int
    total_count: int

    @property
    def progress(self) -> float:
        """Return the fraction of this job's operations that are complete."""
        if self.total_count == 0:
            return 1.0
        return self.completed_count / self.total_count


@dataclass(frozen=True, slots=True)
class SimulationSnapshot:
    """Everything a renderer needs to draw one frame.

    Attributes:
        time: Simulated time this snapshot describes.
        makespan: Time at which the last operation finishes.
        machines: Machine states, ordered by machine identifier.
        jobs: Job states, ordered by job identifier.
        active: Operations in progress at this instant.
        is_complete: Whether simulated time has reached the makespan.
    """

    time: float
    makespan: int
    machines: tuple[MachineState, ...]
    jobs: tuple[JobState, ...]
    active: tuple[ScheduledOperation, ...]
    is_complete: bool

    @property
    def progress(self) -> float:
        """Return elapsed time as a fraction of the makespan, in ``[0.0, 1.0]``."""
        if self.makespan <= 0:
            return 1.0
        return min(1.0, max(0.0, self.time / self.makespan))
