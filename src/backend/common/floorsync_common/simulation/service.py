"""Application operations for schedule timelines and simulation playback.

These are the only modules in the package that touch the database. The resolver
and the event replay stay pure, so `service.py` is a thin layer that loads rows,
calls them, and returns typed outcomes.

Transactions are owned by the caller. Nothing here commits or rolls back;
`flush()` is used only where a generated value or a subsequent read needs it.
"""

from datetime import UTC, datetime
from decimal import Decimal
from typing import Final
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.schedule import SCHEDULE_CONFIRMED
from floorsync_common.database.models.simulation import (
    SIMULATION_COMPLETE,
    SIMULATION_NOT_STARTED,
    SIMULATION_PAUSED,
    SIMULATION_RUNNING,
    Simulation,
)
from floorsync_common.database.models.simulation_event import SimulationEvent
from floorsync_common.simulation import queries
from floorsync_common.simulation.events import (
    SimulatedTimePoint,
    SimulationEventType,
    derive_simulated_time,
)
from floorsync_common.simulation.floorsync import FloorSyncScheduleAdapter
from floorsync_common.simulation.results import (
    ControlNotApplicable,
    ControlPositionRequired,
    ControlRecorded,
    ControlSpeedRequired,
    CreateSimulationResult,
    GetActiveSimulationResult,
    GetScheduleSimulationResult,
    GetSimulationResult,
    GetTimelineResult,
    NoActiveSimulation,
    RecordControlResult,
    ScheduleNotConfirmed,
    ScheduleNotFound,
    ScheduleNotGenerated,
    SimulationAlreadyExists,
    SimulationCreated,
    SimulationForScheduleNotFound,
    SimulationNotFound,
    SimulationPositionResolved,
    TimelineResolved,
)
from floorsync_common.simulation.timeline import Timeline

STATUS_NOT_STARTED: Final = SIMULATION_NOT_STARTED
STATUS_RUNNING: Final = SIMULATION_RUNNING
STATUS_PAUSED: Final = SIMULATION_PAUSED
STATUS_COMPLETE: Final = SIMULATION_COMPLETE

_ALLOWED_FROM: Final[dict[SimulationEventType, frozenset[str]]] = {
    SimulationEventType.STARTED: frozenset({STATUS_NOT_STARTED}),
    SimulationEventType.PAUSED: frozenset({STATUS_RUNNING}),
    SimulationEventType.RESUMED: frozenset({STATUS_PAUSED}),
    SimulationEventType.SPEED_CHANGED: frozenset({STATUS_RUNNING, STATUS_PAUSED}),
    SimulationEventType.RESET: frozenset(
        {STATUS_NOT_STARTED, STATUS_RUNNING, STATUS_PAUSED, STATUS_COMPLETE}
    ),
    SimulationEventType.COMPLETED: frozenset({STATUS_RUNNING}),
    SimulationEventType.SEEKED: frozenset(
        {STATUS_NOT_STARTED, STATUS_RUNNING, STATUS_PAUSED, STATUS_COMPLETE}
    ),
}

_SPEED_REQUIRED: Final[frozenset[SimulationEventType]] = frozenset(
    {
        SimulationEventType.STARTED,
        SimulationEventType.RESUMED,
        SimulationEventType.SPEED_CHANGED,
    }
)


def control_is_applicable(event_type: SimulationEventType, status: str) -> bool:
    """Return whether a control action is valid from a simulation's current status.

    Pure, so the transition table can be tested without a database.
    """
    return status in _ALLOWED_FROM[event_type]


def control_requires_speed(event_type: SimulationEventType) -> bool:
    """Return whether a control action must carry the speed it sets."""
    return event_type in _SPEED_REQUIRED


def control_requires_position(event_type: SimulationEventType) -> bool:
    """Return whether a control action must carry the position it moves the play head to."""
    return event_type is SimulationEventType.SEEKED


class ScheduleTimelineService:
    """Resolve a stored schedule onto the clock. Stateless."""

    @staticmethod
    async def get_timeline(db: AsyncSession, *, schedule_id: UUID) -> GetTimelineResult:
        """Place a schedule's entries on the clock using their stored start times.

        Args:
            db: Caller-owned session inside an open transaction.
            schedule_id: Schedule to resolve.

        Returns:
            The resolved timeline, or the reason one could not be produced.

        Raises:
            ScheduleMismatchError: If an entry has no stored start_time, meaning
                the schedule predates decision 0011 and must be regenerated.
        """
        schedule = await queries.load_schedule(db, schedule_id)
        if schedule is None:
            return ScheduleNotFound(schedule_id=schedule_id)

        entries = await queries.load_schedule_entries(db, schedule_id)
        if not entries:
            return ScheduleNotGenerated(schedule_id=schedule_id)

        timeline = FloorSyncScheduleAdapter.build_timeline(entries)
        return TimelineResolved(schedule=schedule, timeline=timeline)


class SimulationService:
    """Create, read and control the playback of a confirmed schedule. Stateless."""

    @staticmethod
    async def create_simulation(db: AsyncSession, *, schedule_id: UUID) -> CreateSimulationResult:
        """Create the simulation for a confirmed schedule.

        One simulation exists per schedule, so a second request reports the
        existing one rather than adding another; resetting re-initialises it.
        """
        schedule = await queries.load_schedule(db, schedule_id)
        if schedule is None:
            return ScheduleNotFound(schedule_id=schedule_id)
        if schedule.status != SCHEDULE_CONFIRMED:
            return ScheduleNotConfirmed(schedule_id=schedule_id, status=schedule.status)

        existing = await queries.load_simulation_for_schedule(db, schedule_id)
        if existing is not None:
            return SimulationAlreadyExists(schedule_id=schedule_id, simulation_id=existing.id)

        simulation = Simulation(
            schedule_id=schedule_id,
            status=STATUS_NOT_STARTED,
            speed=Decimal("1"),
        )
        db.add(simulation)
        await db.flush()
        return SimulationCreated(simulation=simulation)

    @staticmethod
    async def get_simulation(
        db: AsyncSession, *, simulation_id: UUID, at: datetime | None = None
    ) -> GetSimulationResult:
        """Derive where a simulation sits at ``at``, defaulting to now.

        The position comes from replaying the event log, never from
        ``started_at`` and ``speed`` — see decision 0010.
        """
        simulation = await queries.load_simulation(db, simulation_id)
        if simulation is None:
            return SimulationNotFound(simulation_id=simulation_id)

        timeline = await SimulationService._resolve_timeline(db, simulation.schedule_id)
        if timeline is None:
            return ScheduleNotGenerated(schedule_id=simulation.schedule_id)

        position = await SimulationService._derive_position(
            db, simulation_id=simulation_id, makespan=timeline.makespan, at=at
        )
        return SimulationPositionResolved(
            simulation=simulation, position=position, makespan=timeline.makespan
        )

    @staticmethod
    async def get_active_simulation(
        db: AsyncSession, *, at: datetime | None = None
    ) -> GetActiveSimulationResult:
        """Read the simulation operators should follow, when one has been created."""
        simulation = await queries.load_active_simulation(db)
        if simulation is None:
            return NoActiveSimulation()
        return await SimulationService.get_simulation(db, simulation_id=simulation.id, at=at)

    @staticmethod
    async def get_simulation_for_schedule(
        db: AsyncSession, *, schedule_id: UUID, at: datetime | None = None
    ) -> GetScheduleSimulationResult:
        """Read a schedule's one persisted simulation, when it has been started.

        The browser selects a schedule before it knows its simulation id. This
        lookup makes refresh/re-entry recover the event-sourced position without
        teaching clients to parse a conflict response from ``create_simulation``.
        """
        schedule = await queries.load_schedule(db, schedule_id)
        if schedule is None:
            return ScheduleNotFound(schedule_id=schedule_id)

        simulation = await queries.load_simulation_for_schedule(db, schedule_id)
        if simulation is None:
            return SimulationForScheduleNotFound(schedule_id=schedule_id)

        timeline = await SimulationService._resolve_timeline(db, schedule_id)
        if timeline is None:
            return ScheduleNotGenerated(schedule_id=schedule_id)

        position = await SimulationService._derive_position(
            db, simulation_id=simulation.id, makespan=timeline.makespan, at=at
        )
        return SimulationPositionResolved(
            simulation=simulation, position=position, makespan=timeline.makespan
        )

    @staticmethod
    async def record_control(
        db: AsyncSession,
        *,
        simulation_id: UUID,
        event_type: SimulationEventType,
        speed: Decimal | None = None,
        seek_to: float | None = None,
        at: datetime | None = None,
    ) -> RecordControlResult:
        """Append a control action to the log and re-derive the position.

        The appended event is the authoritative record; the columns on
        ``simulations`` are updated alongside it as a readable projection, not as
        a second source of truth. Completion writes nothing onto the schedule's
        jobs: that they are done is read from this simulation (decision 0019).

        The simulation row is locked for the rest of the transaction, so concurrent
        controls are applied one at a time against the status the previous one left.

        A ``seeked`` control's ``seek_to`` is clamped to the schedule's makespan before it is
        stored, so the log never records a play head past the end of the plan.
        """
        occurred_at = at or datetime.now(UTC)

        simulation = await queries.lock_simulation(db, simulation_id)
        if simulation is None:
            return SimulationNotFound(simulation_id=simulation_id)

        if not control_is_applicable(event_type, simulation.status):
            return ControlNotApplicable(
                simulation_id=simulation_id,
                event_type=event_type,
                status=simulation.status,
            )

        if control_requires_speed(event_type) and speed is None:
            return ControlSpeedRequired(simulation_id=simulation_id, event_type=event_type)

        if control_requires_position(event_type) and seek_to is None:
            return ControlPositionRequired(simulation_id=simulation_id, event_type=event_type)

        timeline = await SimulationService._resolve_timeline(db, simulation.schedule_id)
        if timeline is None:
            return ScheduleNotGenerated(schedule_id=simulation.schedule_id)

        stored_position = (
            min(max(seek_to, 0.0), float(timeline.makespan))
            if control_requires_position(event_type) and seek_to is not None
            else None
        )

        db.add(
            SimulationEvent(
                simulation_id=simulation_id,
                event_type=str(event_type),
                occurred_at=occurred_at,
                speed=speed,
                position=stored_position,
            )
        )
        SimulationService._project_onto_simulation(
            simulation,
            event_type=event_type,
            speed=speed,
            position=stored_position,
            makespan=timeline.makespan,
            occurred_at=occurred_at,
        )
        await db.flush()

        position = await SimulationService._derive_position(
            db, simulation_id=simulation_id, makespan=timeline.makespan, at=occurred_at
        )
        return ControlRecorded(
            simulation=simulation,
            event_type=event_type,
            position=position,
            makespan=timeline.makespan,
        )

    # -- internals -------------------------------------------------------

    @staticmethod
    async def _resolve_timeline(db: AsyncSession, schedule_id: UUID) -> Timeline | None:
        """Resolve a schedule's timeline, or ``None`` when it has no entries.

        The makespan is recomputed rather than read from ``schedules.makespan``,
        which is a value cached at generation time. If this read ever becomes
        hot, that column is the cheaper alternative.
        """
        entries = await queries.load_schedule_entries(db, schedule_id)
        if not entries:
            return None
        return FloorSyncScheduleAdapter.build_timeline(entries)

    @staticmethod
    async def _derive_position(
        db: AsyncSession, *, simulation_id: UUID, makespan: int, at: datetime | None
    ) -> SimulatedTimePoint:
        events = await queries.load_simulation_events(db, simulation_id)
        return derive_simulated_time(events, at=at or datetime.now(UTC), makespan=makespan)

    @staticmethod
    def _project_onto_simulation(
        simulation: Simulation,
        *,
        event_type: SimulationEventType,
        speed: Decimal | None,
        position: float | None,
        makespan: int,
        occurred_at: datetime,
    ) -> None:
        """Update the readable columns on ``simulations`` to match the new event."""
        match event_type:
            case SimulationEventType.STARTED:
                simulation.status = STATUS_RUNNING
                simulation.started_at = occurred_at
                simulation.completed_at = None
                if speed is not None:
                    simulation.speed = speed
            case SimulationEventType.RESUMED:
                simulation.status = STATUS_RUNNING
                simulation.completed_at = None
                if speed is not None:
                    simulation.speed = speed
            case SimulationEventType.SPEED_CHANGED:
                if speed is not None:
                    simulation.speed = speed
            case SimulationEventType.PAUSED:
                simulation.status = STATUS_PAUSED
            case SimulationEventType.RESET:
                simulation.status = STATUS_NOT_STARTED
                simulation.started_at = None
                simulation.completed_at = None
            case SimulationEventType.COMPLETED:
                simulation.status = STATUS_COMPLETE
                simulation.completed_at = occurred_at
            case SimulationEventType.SEEKED:
                # Scrubbing to the end finishes the run; anywhere else leaves a
                # running simulation running and parks any other one, paused.
                if simulation.started_at is None:
                    simulation.started_at = occurred_at
                if position is not None and position >= makespan:
                    simulation.status = STATUS_COMPLETE
                    simulation.completed_at = occurred_at
                else:
                    if simulation.status != STATUS_RUNNING:
                        simulation.status = STATUS_PAUSED
                    simulation.completed_at = None
