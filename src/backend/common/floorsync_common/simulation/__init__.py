"""Replay a solved schedule over simulated time.

A timeline is **derived, never stored**: start and end times are a pure function
of a schedule's assignments and its precedence edges, so they are recomputed on
read rather than persisted and kept in sync. See decision 0009.

The package is layered so each stage is testable without the one above it, and
so both sources of schedules share one resolution:

1. **Core** -- :class:`TimelineNode` and :class:`PrecedenceEdge` express work and
   precedence with opaque string keys; :func:`resolve_start_times` places them on
   the clock with a topological longest path.
2. **Adapters** --
   :class:`~floorsync_common.simulation.floorsync.FloorSyncScheduleAdapter`
   translates ``schedule_entries`` and ``schedule_dependencies`` rows;
   :class:`TimelineBuilder` translates a benchmark instance and solver solution,
   deriving the precedence edges that FloorSync already stores.
3. **Playback** -- :class:`Timeline` answers "what is true at time ``t``";
   :func:`derive_simulated_time` replays a simulation's event log to find that
   ``t`` authoritatively; :class:`PlaybackClock` and :class:`SimulationEngine`
   animate locally between derived positions.

Playback is deterministic. It replays a schedule that has already been generated:
no stochastic durations, no breakdowns, no re-dispatching.

Example:
    >>> timeline = FloorSyncScheduleAdapter.build_timeline(entries, dependencies)  # doctest: +SKIP
    >>> point = derive_simulated_time(events, at=now, makespan=timeline.makespan)  # doctest: +SKIP
    >>> snapshot = SimulationEngine(timeline).seek(point.time)                     # doctest: +SKIP
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
    SimulationTimelineError,
)
from .events import (
    SimulatedTimePoint,
    SimulationEventRecord,
    SimulationEventType,
    derive_simulated_time,
    events_from_rows,
)
from .floorsync import (
    FloorSyncScheduleAdapter,
    ScheduleDependencyRecord,
    ScheduleEntryRecord,
)
from .graph import PrecedenceEdge, PrecedenceReason, TimelineNode, resolve_start_times
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
    "FloorSyncScheduleAdapter",
    "InstanceFormatError",
    "JobShopInstance",
    "JobState",
    "JobStatus",
    "MachineState",
    "MachineStatus",
    "Operation",
    "PlaybackClock",
    "PrecedenceEdge",
    "PrecedenceReason",
    "Schedule",
    "ScheduleDependencyRecord",
    "ScheduleEntryRecord",
    "ScheduleFormatError",
    "ScheduleMismatchError",
    "ScheduledOperation",
    "SimulatedTimePoint",
    "SimulationEngine",
    "SimulationError",
    "SimulationEventRecord",
    "SimulationEventType",
    "SimulationObserver",
    "SimulationSnapshot",
    "SimulationTimelineError",
    "Timeline",
    "TimelineBuilder",
    "TimelineNode",
    "derive_simulated_time",
    "events_from_rows",
    "resolve_start_times",
]
