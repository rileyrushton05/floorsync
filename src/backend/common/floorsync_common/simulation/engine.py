"""The facade a client-side player talks to.

The engine drives a :class:`~floorsync_common.simulation.timeline.Timeline` with
a local :class:`~floorsync_common.simulation.clock.PlaybackClock` and publishes a
snapshot of every machine and job as time moves.

It is deliberately source-agnostic: a timeline built from FloorSync schedule rows
and one built from a benchmark solution drive it identically.

**Authority.** For a stored FloorSync simulation the database is authoritative --
simulated time is derived by replaying ``simulation_events`` (see
:mod:`floorsync_common.simulation.events`), not by trusting a clock in a process
that may have restarted. This engine is the local player used to animate between
those authoritative positions, and for headless work such as tests and exports.
Call :meth:`seek` with a derived position to resynchronise.
"""

from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Protocol, runtime_checkable

from .builder import TimelineBuilder
from .clock import PlaybackClock
from .errors import SimulationError
from .instance import JobShopInstance
from .schedule import Schedule
from .state import JobState, MachineState, SimulationSnapshot
from .timeline import Timeline


@runtime_checkable
class SimulationObserver(Protocol):
    """Anything that reacts to each published snapshot."""

    def on_update(self, snapshot: SimulationSnapshot) -> None:
        """Handle a newly published snapshot."""
        ...


class SimulationEngine:
    """Play a resolved timeline forward over simulated time.

    Provide a timeline directly, or load a benchmark instance and solution. Then
    drive :meth:`tick` from a frame loop, or :meth:`seek` from a scrubber or from
    a position derived off the event log. Either way the engine publishes a
    :class:`~floorsync_common.simulation.state.SimulationSnapshot` to every
    subscriber whenever the displayed instant changes.
    """

    def __init__(self, timeline: Timeline | None = None, tick_epsilon: float = 1e-9) -> None:
        """Create an engine, optionally with a timeline already resolved.

        Args:
            timeline: A resolved timeline to play. Omit to load one later.
            tick_epsilon: Smallest change in simulated time that counts as a new
                frame. Guards against publishing identical snapshots when a tick
                advances the clock by a negligible amount.
        """
        self._instance: JobShopInstance | None = None
        self._schedule: Schedule | None = None
        self._timeline: Timeline | None = timeline
        self._clock = PlaybackClock(duration=float(timeline.makespan) if timeline else 0.0)
        self._observers: list[SimulationObserver | Callable[[SimulationSnapshot], None]] = []
        self._tick_epsilon = tick_epsilon

    # -- loading ---------------------------------------------------------

    def use_timeline(self, timeline: Timeline) -> Timeline:
        """Adopt an already-resolved timeline, from any source.

        This is the entry point for a FloorSync schedule, whose timeline is built
        by :class:`~floorsync_common.simulation.floorsync.FloorSyncScheduleAdapter`.
        """
        self._timeline = timeline
        self._clock.reset(duration=float(timeline.makespan))
        self._publish()
        return timeline

    def load_instance(self, path: Path | str) -> JobShopInstance:
        """Load a benchmark problem definition, discarding any loaded schedule."""
        self._instance = JobShopInstance.load_from_json(path)
        self._schedule = None
        self._timeline = None
        self._clock.reset(duration=0.0)
        return self._instance

    def load_schedule(self, path: Path | str, instance_name: str | None = None) -> Timeline:
        """Load a benchmark solution and build the timeline it implies.

        Args:
            path: Path to a ``solutions_{solver}_{date}.json`` file.
            instance_name: Instance to select when the file holds several
                solutions. Defaults to the loaded instance's name.

        Raises:
            SimulationError: If no instance has been loaded yet.
        """
        if self._instance is None:
            raise SimulationError("Load an instance before loading a schedule.")
        schedule = Schedule.load_from_json(path, instance_name or self._instance.name)
        return self.apply_schedule(schedule)

    def apply_schedule(self, schedule: Schedule) -> Timeline:
        """Build and adopt the timeline for an already-parsed benchmark solution.

        Raises:
            SimulationError: If no instance has been loaded yet.
        """
        if self._instance is None:
            raise SimulationError("Load an instance before applying a schedule.")
        self._schedule = schedule
        return self.use_timeline(TimelineBuilder.build(self._instance, schedule))

    # -- playback --------------------------------------------------------

    def tick(self, real_delta: float) -> SimulationSnapshot:
        """Advance simulated time and publish the resulting frame."""
        advanced = self._clock.tick(real_delta)
        snapshot = self.snapshot()
        if abs(advanced) > self._tick_epsilon:
            self._notify(snapshot)
        return snapshot

    def seek(self, time: float) -> SimulationSnapshot:
        """Jump to ``time`` and publish the resulting frame."""
        self._clock.seek(time)
        return self._publish()

    def seek_fraction(self, fraction: float) -> SimulationSnapshot:
        """Jump to a fraction of the run and publish the resulting frame."""
        self._clock.seek_fraction(fraction)
        return self._publish()

    def play(self) -> None:
        """Start playback."""
        self._clock.play()

    def pause(self) -> None:
        """Pause playback."""
        self._clock.pause()

    def set_speed(self, speed: float) -> None:
        """Set the playback rate."""
        self._clock.set_speed(speed)

    def reset(self) -> SimulationSnapshot:
        """Rewind to time zero, pause, and publish the resulting frame."""
        self._clock.reset()
        return self._publish()

    # -- state -----------------------------------------------------------

    def snapshot(self) -> SimulationSnapshot:
        """Return the state of every machine and job at the current instant.

        Raises:
            SimulationError: If no timeline has been adopted yet.
        """
        timeline = self._require_timeline()
        now = self._clock.current_time
        return SimulationSnapshot(
            time=now,
            makespan=timeline.makespan,
            machines=tuple(timeline.machine_status_at(key, now) for key in timeline.machine_keys),
            jobs=tuple(timeline.job_status_at(key, now) for key in timeline.job_keys),
            active=timeline.active_at(now),
            is_complete=now >= timeline.makespan,
        )

    def frames(self, step: float = 1.0) -> Iterator[SimulationSnapshot]:
        """Yield a snapshot at each fixed interval from zero to the makespan.

        This is the headless path, useful for tests, exporting an animation and
        eyeballing a small schedule without a UI attached.

        Args:
            step: Simulated time between successive frames. Must be positive.
        """
        if step <= 0:
            raise ValueError("Frame step must be positive.")
        timeline = self._require_timeline()
        resume = self._clock.current_time
        try:
            time = 0.0
            while time < timeline.makespan:
                self._clock.seek(time)
                yield self.snapshot()
                time += step
            self._clock.seek(float(timeline.makespan))
            yield self.snapshot()
        finally:
            self._clock.seek(resume)

    def machine_state(self, machine_key: str) -> MachineState:
        """Return one machine's state at the current instant."""
        return self._require_timeline().machine_status_at(machine_key, self._clock.current_time)

    def job_state(self, job_key: str) -> JobState:
        """Return one job's state at the current instant."""
        return self._require_timeline().job_status_at(job_key, self._clock.current_time)

    # -- observers -------------------------------------------------------

    def subscribe(
        self, observer: SimulationObserver | Callable[[SimulationSnapshot], None]
    ) -> Callable[[], None]:
        """Register an observer and return a callable that unsubscribes it.

        Accepts either an object with an ``on_update`` method or a plain
        callable, so a view class and a one-line lambda are equally welcome.
        """
        self._observers.append(observer)
        return lambda: self.unsubscribe(observer)

    def unsubscribe(
        self, observer: SimulationObserver | Callable[[SimulationSnapshot], None]
    ) -> None:
        """Remove a previously registered observer, ignoring unknown ones."""
        if observer in self._observers:
            self._observers.remove(observer)

    # -- properties ------------------------------------------------------

    @property
    def instance(self) -> JobShopInstance | None:
        """Return the loaded benchmark instance, or ``None``."""
        return self._instance

    @property
    def schedule(self) -> Schedule | None:
        """Return the applied benchmark solution, or ``None``."""
        return self._schedule

    @property
    def timeline(self) -> Timeline | None:
        """Return the adopted timeline, or ``None``."""
        return self._timeline

    @property
    def clock(self) -> PlaybackClock:
        """Return the playback clock, for direct control by a transport bar."""
        return self._clock

    @property
    def is_ready(self) -> bool:
        """Return whether a timeline has been adopted."""
        return self._timeline is not None

    # -- internals -------------------------------------------------------

    def _require_timeline(self) -> Timeline:
        if self._timeline is None:
            raise SimulationError("Adopt a timeline before reading simulation state.")
        return self._timeline

    def _publish(self) -> SimulationSnapshot:
        snapshot = self.snapshot()
        self._notify(snapshot)
        return snapshot

    def _notify(self, snapshot: SimulationSnapshot) -> None:
        for observer in list(self._observers):
            if isinstance(observer, SimulationObserver):
                observer.on_update(snapshot)
            else:
                observer(snapshot)
