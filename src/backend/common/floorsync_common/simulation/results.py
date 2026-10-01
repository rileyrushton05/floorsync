"""Expected outcomes for the schedule timeline and simulation operations.

Success variants are plain frozen dataclasses; every expected non-success
outcome inherits :class:`~floorsync_common.outcomes.ExpectedOutcome` and is
handled exhaustively at the web edge, per decision 0004. Infrastructure
failures and broken invariants still raise.
"""

from dataclasses import dataclass
from uuid import UUID

from floorsync_common.database.models.schedule import Schedule
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.outcomes import ExpectedOutcome
from floorsync_common.simulation.events import SimulatedTimePoint, SimulationEventType
from floorsync_common.simulation.timeline import Timeline

# -- shared schedule outcomes --------------------------------------------


@dataclass(frozen=True, slots=True)
class ScheduleNotFound(ExpectedOutcome):
    """No schedule exists with this identifier."""

    schedule_id: UUID


@dataclass(frozen=True, slots=True)
class ScheduleNotGenerated(ExpectedOutcome):
    """The schedule exists but has no entries, so no timeline can be resolved."""

    schedule_id: UUID


# -- timeline ------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TimelineResolved:
    """A schedule's entries and dependencies resolved onto the clock."""

    schedule: Schedule
    timeline: Timeline


type GetTimelineResult = TimelineResolved | ScheduleNotFound | ScheduleNotGenerated


# -- creating a simulation -----------------------------------------------


@dataclass(frozen=True, slots=True)
class SimulationCreated:
    """A simulation was created for a confirmed schedule."""

    simulation: Simulation


@dataclass(frozen=True, slots=True)
class ScheduleNotConfirmed(ExpectedOutcome):
    """Only a confirmed schedule may be handed to simulation."""

    schedule_id: UUID
    status: str


@dataclass(frozen=True, slots=True)
class SimulationAlreadyExists(ExpectedOutcome):
    """One simulation per schedule; reset re-initialises it rather than adding another."""

    schedule_id: UUID
    simulation_id: UUID


type CreateSimulationResult = (
    SimulationCreated | ScheduleNotFound | ScheduleNotConfirmed | SimulationAlreadyExists
)


# -- reading a simulation ------------------------------------------------


@dataclass(frozen=True, slots=True)
class SimulationNotFound(ExpectedOutcome):
    """No simulation exists with this identifier."""

    simulation_id: UUID


@dataclass(frozen=True, slots=True)
class SimulationForScheduleNotFound(ExpectedOutcome):
    """No simulation has been started for this schedule yet."""

    schedule_id: UUID


@dataclass(frozen=True, slots=True)
class SimulationPositionResolved:
    """Where a simulation sits, derived from its event log."""

    simulation: Simulation
    position: SimulatedTimePoint
    makespan: int


type GetSimulationResult = SimulationPositionResolved | SimulationNotFound | ScheduleNotGenerated
type GetScheduleSimulationResult = (
    SimulationPositionResolved
    | ScheduleNotFound
    | SimulationForScheduleNotFound
    | ScheduleNotGenerated
)


# -- recording a control action ------------------------------------------


@dataclass(frozen=True, slots=True)
class ControlRecorded:
    """A control action was appended to the log and the position re-derived."""

    simulation: Simulation
    event_type: SimulationEventType
    position: SimulatedTimePoint
    makespan: int


@dataclass(frozen=True, slots=True)
class ControlNotApplicable(ExpectedOutcome):
    """The control action is not valid from the simulation's current status."""

    simulation_id: UUID
    event_type: SimulationEventType
    status: str


@dataclass(frozen=True, slots=True)
class ControlSpeedRequired(ExpectedOutcome):
    """The control action sets a speed but none was supplied."""

    simulation_id: UUID
    event_type: SimulationEventType


type RecordControlResult = (
    ControlRecorded
    | SimulationNotFound
    | ScheduleNotGenerated
    | ControlNotApplicable
    | ControlSpeedRequired
)
