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
from floorsync_api.features.simulation.schemas import (
    SimulationCreateRequest,
    SimulationEventRequest,
    SimulationResponse,
    TimelineResponse,
)
from floorsync_common.database.models.user import User
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
    SimulationForScheduleNotFound,
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

    The result is immutable for a confirmed schedule. Clients use it to draw the
    plan, then read the schedule's simulation endpoint for a durable position.
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
    """
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

    response.headers["Location"] = f"/api/v1/simulations/{simulation.id}"
    return _position_response(resolved)


@router.get(
    "/schedules/{schedule_id}/simulation",
    response_model=SimulationResponse,
    summary="Get a schedule's persisted simulation position",
)
async def get_schedule_simulation(
    schedule_id: UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> SimulationResponse:
    """Recover the one simulation for a schedule, including its replayed clock.

    A manager normally reaches the simulation screen with a schedule id, not a
    simulation id. Returning 404 when no simulation has been created keeps
    "start simulation" an explicit action while allowing a refresh to recover
    any existing event log.
    """
    async with db.begin():
        result = await SimulationService.get_simulation_for_schedule(db, schedule_id=schedule_id)

    match result:
        case SimulationPositionResolved():
            return _position_response(result)
        case ScheduleNotFound(schedule_id=missing):
            raise schedule_not_found(missing)
        case SimulationForScheduleNotFound(schedule_id=missing):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No simulation has been started for schedule {missing}.",
            )
        case ScheduleNotGenerated(schedule_id=ungenerated):
            raise schedule_not_generated(ungenerated)
        case _:
            assert_never(result)


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
    """
    occurred_at = datetime.now(UTC)
    async with db.begin():
        result = await SimulationService.record_control(
            db,
            simulation_id=simulation_id,
            event_type=SimulationEventType(command.event_type),
            speed=command.speed,
            at=occurred_at,
        )

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
