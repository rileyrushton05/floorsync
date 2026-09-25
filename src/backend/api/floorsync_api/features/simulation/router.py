"""HTTP routes for reading a schedule's timeline and controlling its playback.

Reads are open to any signed-in account so operators can watch the floor.
Control actions are restricted to managers, who are the accounts that hand a
schedule to simulation in the first place.
"""

from datetime import UTC, datetime
from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status

from floorsync_api.dependencies.authentication import CurrentUser, require_roles
from floorsync_api.dependencies.database import DbSession
from floorsync_api.features.live_updates.publisher import OutboxPublisher
from floorsync_api.features.simulation.schemas import (
    SimulationCreateRequest,
    SimulationEventRequest,
    SimulationResponse,
    TimelineResponse,
)
from floorsync_common.database.models.user import User
from floorsync_common.live_updates.contracts import LiveUpdateCause
from floorsync_common.live_updates.service import LiveUpdateOutboxService
from floorsync_common.simulation.events import SimulationEventType
from floorsync_common.simulation.results import (
    ControlNotApplicable,
    ControlRecorded,
    ControlSpeedRequired,
    ScheduleNotConfirmed,
    ScheduleNotFound,
    ScheduleNotGenerated,
    SimulationAlreadyExists,
    SimulationCreated,
    SimulationNotFound,
    SimulationPositionResolved,
    TimelineResolved,
)
from floorsync_common.simulation.service import ScheduleTimelineService, SimulationService

router = APIRouter(tags=["simulation"])

ManagerUser = Annotated[User, Depends(require_roles("manager"))]


def schedule_not_found(schedule_id: UUID) -> HTTPException:
    """Return a not-found response for an unknown schedule."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"No schedule exists with id {schedule_id}.",
    )


def simulation_not_found(simulation_id: UUID) -> HTTPException:
    """Return a not-found response for an unknown simulation."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"No simulation exists with id {simulation_id}.",
    )


def schedule_not_generated(schedule_id: UUID) -> HTTPException:
    """Return a conflict response for a schedule that has no entries yet."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"Schedule {schedule_id} has no entries, so no timeline can be resolved.",
    )


@router.get(
    "/schedules/{schedule_id}/timeline",
    response_model=TimelineResponse,
    summary="Get a schedule resolved onto the clock",
)
async def get_schedule_timeline(
    schedule_id: UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> TimelineResponse:
    """Resolve a schedule's entries and dependencies into start and end times.

    The result is immutable for a confirmed schedule, so a client should fetch it
    once per schedule and animate locally rather than polling.
    """
    async with db.begin():
        result = await ScheduleTimelineService.get_timeline(db, schedule_id=schedule_id)

    match result:
        case TimelineResolved(timeline=timeline):
            return TimelineResponse.from_timeline(schedule_id, timeline)
        case ScheduleNotFound(schedule_id=missing):
            raise schedule_not_found(missing)
        case ScheduleNotGenerated(schedule_id=ungenerated):
            raise schedule_not_generated(ungenerated)
        case _:
            assert_never(result)


@router.post(
    "/simulations",
    response_model=SimulationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Start simulating a confirmed schedule",
)
async def create_simulation(
    command: SimulationCreateRequest,
    db: DbSession,
    current_user: ManagerUser,
    response: Response,
) -> SimulationResponse:
    """Create the simulation for a confirmed schedule.

    A schedule has at most one simulation; resetting re-initialises that row
    rather than creating another, so a repeat request reports a conflict.

    Creating a simulation is a change too (decision 0017), so it is announced on the live channel
    with cause "created" alongside the response -- it appends no `simulation_events` row, which is
    why this is enqueued here rather than inside `SimulationService.create_simulation` itself.
    """
    occurred_at = datetime.now(UTC)
    outbox_id: UUID | None = None
    async with db.begin():
        created = await SimulationService.create_simulation(db, schedule_id=command.schedule_id)
        match created:
            case SimulationCreated(simulation=simulation):
                resolved = await SimulationService.get_simulation(db, simulation_id=simulation.id)
            case ScheduleNotFound(schedule_id=missing):
                raise schedule_not_found(missing)
            case ScheduleNotConfirmed(schedule_id=unconfirmed, status=schedule_status):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        f"Schedule {unconfirmed} is {schedule_status}; only a confirmed "
                        f"schedule can be simulated."
                    ),
                )
            case SimulationAlreadyExists(simulation_id=existing):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"That schedule is already simulated as {existing}.",
                )
            case _:
                assert_never(created)

        match resolved:
            case SimulationPositionResolved():
                enqueued = await LiveUpdateOutboxService.enqueue_simulation_change(
                    db,
                    simulation=resolved.simulation,
                    position=resolved.position,
                    makespan=resolved.makespan,
                    cause="created",
                    occurred_at=occurred_at,
                )
                outbox_id = enqueued.outbox_id
            case SimulationNotFound() | ScheduleNotGenerated():
                # get_simulation failed right after creating it -- nothing to announce;
                # _position_response below raises the appropriate error for both cases.
                pass
            case _:
                assert_never(resolved)

    if outbox_id is not None:
        await OutboxPublisher.publish_now(db, outbox_id)

    response.headers["Location"] = f"/api/v1/simulations/{simulation.id}"
    return _position_response(resolved)


@router.get(
    "/simulations/{simulation_id}",
    response_model=SimulationResponse,
    summary="Get a simulation's derived position",
)
async def get_simulation(
    simulation_id: UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> SimulationResponse:
    """Derive where a simulation currently sits by replaying its event log."""
    async with db.begin():
        result = await SimulationService.get_simulation(db, simulation_id=simulation_id)

    return _position_response(result)


@router.post(
    "/simulations/{simulation_id}/events",
    response_model=SimulationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Record a playback control action",
)
async def create_simulation_event(
    simulation_id: UUID,
    command: SimulationEventRequest,
    db: DbSession,
    current_user: ManagerUser,
    response: Response,
) -> SimulationResponse:
    """Append a control action and return the position it produces.

    Control actions are a subordinate resource rather than verbs in the path, so
    play, pause, resume, speed change, reset and completion all post here. The
    `Location` header points at the simulation the action affected, since events
    are not individually addressable.

    A recorded control is announced on the live channel (decision 0017): the outbox row commits
    in the same transaction as the event, and is published to Redis only once that transaction
    has committed, so a client never sees a notification for a change that did not happen.
    """
    occurred_at = datetime.now(UTC)
    event_type = SimulationEventType(command.event_type)
    outbox_id: UUID | None = None
    async with db.begin():
        result = await SimulationService.record_control(
            db,
            simulation_id=simulation_id,
            event_type=event_type,
            speed=command.speed,
            at=occurred_at,
        )

        match result:
            case ControlRecorded():
                enqueued = await LiveUpdateOutboxService.enqueue_simulation_change(
                    db,
                    simulation=result.simulation,
                    position=result.position,
                    makespan=result.makespan,
                    cause=_live_update_cause(event_type),
                    occurred_at=occurred_at,
                )
                outbox_id = enqueued.outbox_id
            case (
                SimulationNotFound()
                | ScheduleNotGenerated()
                | ControlNotApplicable()
                | ControlSpeedRequired()
            ):
                pass
            case _:
                assert_never(result)

    if outbox_id is not None:
        await OutboxPublisher.publish_now(db, outbox_id)

    match result:
        case ControlRecorded(simulation=simulation, position=position, makespan=makespan):
            response.headers["Location"] = f"/api/v1/simulations/{simulation.id}"
            return SimulationResponse.from_position(simulation, position, makespan, occurred_at)
        case SimulationNotFound(simulation_id=missing):
            raise simulation_not_found(missing)
        case ScheduleNotGenerated(schedule_id=ungenerated):
            raise schedule_not_generated(ungenerated)
        case ControlNotApplicable(event_type=event_type, status=simulation_status):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Cannot record '{event_type}' while the simulation is {simulation_status}.",
            )
        case ControlSpeedRequired(event_type=event_type):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"A speed is required to record '{event_type}'.",
            )
        case _:
            assert_never(result)


def _position_response(
    result: SimulationPositionResolved | SimulationNotFound | ScheduleNotGenerated,
) -> SimulationResponse:
    """Map a derived-position outcome onto its HTTP response."""
    match result:
        case SimulationPositionResolved(
            simulation=simulation, position=position, makespan=makespan
        ):
            return SimulationResponse.from_position(
                simulation, position, makespan, datetime.now(UTC)
            )
        case SimulationNotFound(simulation_id=missing):
            raise simulation_not_found(missing)
        case ScheduleNotGenerated(schedule_id=ungenerated):
            raise schedule_not_generated(ungenerated)
        case _:
            assert_never(result)


def _live_update_cause(event_type: SimulationEventType) -> LiveUpdateCause:
    """Map a persisted control to the wire cause it announces (decision 0017).

    Not a reuse of `SimulationEventType`'s own value: `cause` is a wire contract `live_updates`
    owns independently, so a database rename must not silently change what a client reads.
    """
    match event_type:
        case SimulationEventType.STARTED:
            return "started"
        case SimulationEventType.PAUSED:
            return "paused"
        case SimulationEventType.RESUMED:
            return "resumed"
        case SimulationEventType.SPEED_CHANGED:
            return "speed_changed"
        case SimulationEventType.RESET:
            return "reset"
        case SimulationEventType.COMPLETED:
            return "completed"
        case _:
            assert_never(event_type)
