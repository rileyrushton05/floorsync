"""Derive simulated time by replaying a simulation's control events.

``simulations.started_at`` and ``simulations.speed`` alone cannot express where a
paused simulation sits: ``(now - started_at) * speed`` keeps advancing in real
time while playback is stopped. ``docs/database-schema.md`` records the fix, and
this module is it -- simulated time is replayed from the append-only
``simulation_events`` log, so a pause, a resume and a speed change each contribute
only the real time that actually elapsed under the speed in force at the time.

The replay is a pure function over plain records, so it is testable without a
database and callable from both the API and a worker.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import assert_never

from .errors import SimulationTimelineError


class SimulationEventType(StrEnum):
    """A playback control action.

    Values match the ``event_type`` check constraint on ``simulation_events``.
    """

    STARTED = "started"
    PAUSED = "paused"
    RESUMED = "resumed"
    SPEED_CHANGED = "speed_changed"
    RESET = "reset"
    COMPLETED = "completed"
    SEEKED = "seeked"


@dataclass(frozen=True, slots=True)
class SimulationEventRecord:
    """One ``simulation_events`` row.

    Attributes:
        event_type: Which control action occurred.
        occurred_at: When it occurred, in real time.
        speed: Speed set by this event. Present on ``started``, ``resumed`` and
            ``speed_changed``; ``None`` otherwise.
        position: Simulated time a ``seeked`` event jumps to; ``None`` otherwise.
    """

    event_type: SimulationEventType
    occurred_at: datetime
    speed: Decimal | None
    position: float | None = None


@dataclass(frozen=True, slots=True)
class SimulatedTimePoint:
    """Where a simulation sits at one real-world moment.

    Attributes:
        time: Simulated time elapsed, in the schedule's own units.
        speed: Speed currently in force.
        is_running: Whether simulated time is still advancing.
        is_complete: Whether playback has reached the end of the schedule.
    """

    time: float
    speed: float
    is_running: bool
    is_complete: bool


DEFAULT_SPEED = 1.0


def derive_simulated_time(
    events: Iterable[SimulationEventRecord],
    *,
    at: datetime,
    makespan: int | None = None,
) -> SimulatedTimePoint:
    """Replay a simulation's event log to find its position at ``at``.

    Args:
        events: Every event for one simulation. Replayed in ``occurred_at``
            order, so the caller does not have to pre-sort.
        at: The real-world moment to evaluate. Must be timezone-aware, matching
            the stored ``occurred_at`` values.
        makespan: End of the schedule being played. When given, simulated time is
            clamped to it and the result reports completion.

    Returns:
        The simulated position at ``at``.

    Raises:
        SimulationTimelineError: If ``at`` or any event timestamp is naive, or if
            a speed-setting event carries no speed.
    """
    if at.tzinfo is None:
        raise SimulationTimelineError("'at' must be timezone-aware to replay an event log.")

    ordered = sorted(events, key=lambda event: event.occurred_at)
    for event in ordered:
        if event.occurred_at.tzinfo is None:
            raise SimulationTimelineError(
                f"Event '{event.event_type}' has a naive timestamp; stored events are "
                f"timezone-aware."
            )

    elapsed = 0.0
    speed = DEFAULT_SPEED
    running = False
    completed = False
    marker: datetime | None = None

    def advance(until: datetime) -> float:
        if not running or marker is None:
            return 0.0
        seconds = (until - marker).total_seconds()
        return max(0.0, seconds) * speed

    for event in ordered:
        elapsed += advance(event.occurred_at)
        marker = event.occurred_at

        match event.event_type:
            case SimulationEventType.STARTED | SimulationEventType.RESUMED:
                speed = _required_speed(event)
                running = True
                completed = False
            case SimulationEventType.SPEED_CHANGED:
                speed = _required_speed(event)
            case SimulationEventType.PAUSED:
                running = False
            case SimulationEventType.RESET:
                elapsed = 0.0
                running = False
                completed = False
            case SimulationEventType.COMPLETED:
                running = False
                completed = True
            case SimulationEventType.SEEKED:
                # A scrub moves the play head without touching playback: a running
                # simulation keeps running from the new position. A scrub to the end
                # finishes playback, as the stored status does, so a later scrub back
                # lands paused rather than resuming a clock nobody restarted.
                elapsed = _required_position(event)
                if makespan is not None and elapsed >= makespan:
                    running = False
                    completed = True
                else:
                    completed = False
            case _:  # pragma: no cover - exhaustive over the enum
                assert_never(event.event_type)

    elapsed += advance(at)

    if makespan is not None and elapsed >= makespan:
        elapsed = float(makespan)
        running = False
        completed = True

    return SimulatedTimePoint(
        time=elapsed,
        speed=speed,
        is_running=running,
        is_complete=completed,
    )


def _required_speed(event: SimulationEventRecord) -> float:
    """Return the speed an event sets.

    Raises:
        SimulationTimelineError: If the event carries no speed, or a speed that
            is not positive.
    """
    if event.speed is None:
        raise SimulationTimelineError(
            f"Event '{event.event_type}' must carry a speed but none was stored."
        )
    speed = float(event.speed)
    if speed <= 0:
        raise SimulationTimelineError(
            f"Event '{event.event_type}' carries a non-positive speed of {speed}."
        )
    return speed


def _required_position(event: SimulationEventRecord) -> float:
    """Return the simulated time a ``seeked`` event jumps to.

    Raises:
        SimulationTimelineError: If the event carries no position, or a negative one.
    """
    if event.position is None:
        raise SimulationTimelineError(
            f"Event '{event.event_type}' must carry a position but none was stored."
        )
    if event.position < 0:
        raise SimulationTimelineError(
            f"Event '{event.event_type}' carries a negative position of {event.position}."
        )
    return float(event.position)


def events_from_rows(
    rows: Iterable[tuple[str, datetime, Decimal | None, float | None]],
) -> list[SimulationEventRecord]:
    """Build event records from ``event_type, occurred_at, speed, position`` rows.

    Raises:
        SimulationTimelineError: If a stored ``event_type`` is not a known value.
    """
    records: list[SimulationEventRecord] = []
    for event_type, occurred_at, speed, position in rows:
        try:
            parsed = SimulationEventType(event_type)
        except ValueError as exc:
            raise SimulationTimelineError(
                f"Simulation event has unknown type '{event_type}'."
            ) from exc
        records.append(
            SimulationEventRecord(
                event_type=parsed, occurred_at=occurred_at, speed=speed, position=position
            )
        )
    return records
