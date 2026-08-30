"""Replay a solved job shop schedule over simulated time.

The package is layered so each stage can be tested without the one above it:

1. **Problem definition** -- :class:`Operation` and :class:`JobShopInstance` parse
   an instance document into the work that exists and each job's routing.
2. **Timeline resolution** -- :class:`Schedule` parses a solver's machine
   sequences, and :class:`TimelineBuilder` resolves those sequences plus job
   precedence into a :class:`Timeline` of operations with concrete times.
3. **Playback runtime** -- :class:`PlaybackClock` moves over the timeline and
   :class:`SimulationEngine` publishes a :class:`SimulationSnapshot` of every
   machine and job at the current instant.

Playback is deterministic: it replays a schedule that has already been solved.
There is no stochastic behaviour, no machine breakdown and no re-dispatching.

Example:
    >>> engine = SimulationEngine()
    >>> engine.load_instance("instances/json/ft06.json")     # doctest: +SKIP
    >>> engine.load_schedule("solutions_CP-SAT_2026-08-30.json")  # doctest: +SKIP
    >>> engine.seek(12).machines[0].status                   # doctest: +SKIP
    <MachineStatus.BUSY: 'busy'>
"""

from .builder import TimelineBuilder
from .clock import PlaybackClock
from .engine import SimulationEngine, SimulationObserver
from .errors import (
    CyclicScheduleError,
    InstanceFormatError,
    ScheduleFormatError,
    ScheduleMismatchError,
    SimulationError,
)
from .instance import JobShopInstance, Operation
from .schedule import Schedule
from .state import (
    JobState,
    JobStatus,
    MachineState,
    MachineStatus,
    SimulationSnapshot,
)
from .timeline import ScheduledOperation, Timeline

__all__ = [
    "CyclicScheduleError",
    "InstanceFormatError",
    "JobShopInstance",
    "JobState",
    "JobStatus",
    "MachineState",
    "MachineStatus",
    "Operation",
    "PlaybackClock",
    "Schedule",
    "ScheduleFormatError",
    "ScheduleMismatchError",
    "ScheduledOperation",
    "SimulationEngine",
    "SimulationError",
    "SimulationObserver",
    "SimulationSnapshot",
    "Timeline",
    "TimelineBuilder",
]
