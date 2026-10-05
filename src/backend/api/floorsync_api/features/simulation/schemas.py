"""HTTP contracts for the schedule timeline and simulation playback endpoints."""

from datetime import datetime
from decimal import Decimal
from typing import Literal, cast
from uuid import UUID

from pydantic import Field

from floorsync_api.schemas import RequestSchema, ResponseSchema
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.simulation.events import SimulatedTimePoint
from floorsync_common.simulation.timeline import Timeline

type SimulationStatus = Literal["not_started", "running", "paused", "complete"]
type SimulationControl = Literal[
    "started", "paused", "resumed", "speed_changed", "reset", "completed", "seeked"
]


class TimelineLaneResponse(ResponseSchema):
    """A machine lane or job row, identified by key and shown by label."""

    key: str
    label: str


class TimelineOperationResponse(ResponseSchema):
    """One scheduled operation, ready to draw as a bar."""

    key: str
    job_key: str
    machine_key: str
    label: str
    start: int
    end: int
    machine_slot: int


class TimelineResponse(ResponseSchema):
    """A schedule resolved onto the clock.

    Machines and jobs are listed separately from operations so a renderer can lay
    out lanes and rows without scanning every operation to discover them.

    The payload is immutable for a confirmed schedule: the same entries and
    dependencies always resolve to the same times, so a client may fetch it once
    and animate locally against it.
    """

    schedule_id: UUID
    makespan: int
    machines: list[TimelineLaneResponse]
    jobs: list[TimelineLaneResponse]
    operations: list[TimelineOperationResponse]

    @classmethod
    def from_timeline(cls, schedule_id: UUID, timeline: Timeline) -> "TimelineResponse":
        """Build the response from a resolved timeline."""
        machines = [
            TimelineLaneResponse(key=key, label=timeline.machine_status_at(key, 0).machine_label)
            for key in timeline.machine_keys
        ]
        jobs = [
            TimelineLaneResponse(key=key, label=timeline.job_status_at(key, 0).job_label)
            for key in timeline.job_keys
        ]
        operations = [
            TimelineOperationResponse(
                key=item.key,
                job_key=item.job_key,
                machine_key=item.machine_key,
                label=item.operation_label,
                start=item.start_time,
                end=item.end_time,
                machine_slot=item.machine_slot,
            )
            for item in timeline.operations
        ]
        return cls(
            schedule_id=schedule_id,
            makespan=timeline.makespan,
            machines=machines,
            jobs=jobs,
            operations=operations,
        )


class SimulationResponse(ResponseSchema):
    """A simulation and the position derived from its event log.

    ``simulated_time`` is a derived measurement in the schedule's own units, so it
    is a float rather than an exact decimal. ``speed`` mirrors the stored
    ``Numeric(5, 2)`` column and stays a decimal.
    """

    id: UUID
    schedule_id: UUID
    status: SimulationStatus
    speed: Decimal
    simulated_time: float
    makespan: int
    is_running: bool
    is_complete: bool
    derived_at: datetime

    @classmethod
    def from_position(
        cls,
        simulation: Simulation,
        position: SimulatedTimePoint,
        makespan: int,
        derived_at: datetime,
    ) -> "SimulationResponse":
        """Build the response from a simulation and its derived position."""
        return cls(
            id=simulation.id,
            schedule_id=simulation.schedule_id,
            # The column is a plain string guarded by a CHECK constraint; Pydantic
            # re-validates it against the Literal when the model is constructed.
            status=cast(SimulationStatus, simulation.status),
            speed=simulation.speed,
            simulated_time=position.time,
            makespan=makespan,
            is_running=position.is_running,
            is_complete=position.is_complete,
            derived_at=derived_at,
        )


class SimulationCreateRequest(RequestSchema):
    """Create the simulation for a confirmed schedule."""

    schedule_id: UUID


class SimulationEventRequest(RequestSchema):
    """Record one playback control action.

    ``speed`` is required for ``started``, ``resumed`` and ``speed_changed``, and
    ignored otherwise. ``position`` is the simulated time a ``seeked`` control moves
    the play head to; it is required there, clamped to the makespan, and ignored
    otherwise.
    """

    event_type: SimulationControl
    speed: Decimal | None = None
    position: float | None = Field(default=None, ge=0, allow_inf_nan=False)
