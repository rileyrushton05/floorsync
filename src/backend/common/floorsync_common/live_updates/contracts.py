"""The wire contract for one simulation change.

This is what an outbox row stores and what crosses Redis. It is deliberately not an ORM
serialisation: the fields are the public, versioned shape that #154 and #155 build against, so a
column rename must not change it. The envelope carries only the audience-free anchor; the API adds
the manager or operator machine projection at delivery time.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, get_args
from uuid import UUID

ENVELOPE_VERSION = 1
"""Bump when a field changes meaning or is removed. Adding an optional field does not need it."""

SIMULATION_CHANGED = "simulation.changed"
"""The one topic today. The outbox and the Redis channel are both keyed by it."""

type LiveUpdateCause = Literal[
    "created", "started", "paused", "resumed", "speed_changed", "reset", "completed", "seeked"
]
"""Why the anchor moved. The simulation event types plus `created`, which appends no event."""

CAUSES: tuple[LiveUpdateCause, ...] = get_args(LiveUpdateCause.__value__)


class UnsupportedEnvelope(ValueError):
    """A payload this version of the contract cannot read. Log the event id and drop it."""


@dataclass(frozen=True, slots=True)
class SimulationAnchor:
    """Where the simulation sat the moment the change was recorded.

    `speed` mirrors the stored `Numeric(5, 2)` and stays exact; `simulated_time` is a derived
    measurement and stays a float, as the REST response already does.
    """

    status: str
    simulated_time: float
    speed: Decimal
    makespan: int
    observed_at: datetime


@dataclass(frozen=True, slots=True)
class SimulationChangedEnvelope:
    """One `simulation.changed` notification.

    `event_id` is the outbox row's id, so the row that will be retried, the message on the channel
    and the frame a client deduplicates are one identity. `sequence` is per simulation and strictly
    increasing: a client that sees a lower one discards it, a client that sees a gap refetches.
    """

    event_id: UUID
    simulation_id: UUID
    sequence: int
    occurred_at: datetime
    cause: LiveUpdateCause
    snapshot: SimulationAnchor
    v: int = ENVELOPE_VERSION
    topic: str = SIMULATION_CHANGED

    def to_payload(self) -> dict[str, Any]:
        """The JSON-ready shape stored in the outbox and published on the channel."""
        return {
            "v": self.v,
            "topic": self.topic,
            "event_id": str(self.event_id),
            "simulation_id": str(self.simulation_id),
            "sequence": self.sequence,
            "occurred_at": self.occurred_at.isoformat(),
            "cause": self.cause,
            "snapshot": {
                "status": self.snapshot.status,
                "simulated_time": self.snapshot.simulated_time,
                "speed": str(self.snapshot.speed),
                "makespan": self.snapshot.makespan,
                "observed_at": self.snapshot.observed_at.isoformat(),
            },
        }

    @classmethod
    def from_payload(cls, payload: Any) -> SimulationChangedEnvelope:
        """Read a payload back, refusing anything this contract version cannot vouch for.

        Every field is checked, because the payload may have come from an older or newer process
        over Redis rather than from this code.
        """
        if not isinstance(payload, dict):
            raise UnsupportedEnvelope("Payload is not an object.")
        if payload.get("v") != ENVELOPE_VERSION:
            raise UnsupportedEnvelope(f"Unsupported envelope version {payload.get('v')!r}.")
        if payload.get("topic") != SIMULATION_CHANGED:
            raise UnsupportedEnvelope(f"Unsupported topic {payload.get('topic')!r}.")
        try:
            snapshot = payload["snapshot"]
            if not isinstance(snapshot, dict):
                raise UnsupportedEnvelope("Snapshot is not an object.")
            cause = payload["cause"]
            if cause not in CAUSES:
                raise UnsupportedEnvelope(f"Unknown cause {cause!r}.")
            return cls(
                event_id=UUID(payload["event_id"]),
                simulation_id=UUID(payload["simulation_id"]),
                sequence=_int(payload["sequence"], "sequence"),
                occurred_at=_aware(payload["occurred_at"], "occurred_at"),
                cause=cause,
                snapshot=SimulationAnchor(
                    status=_text(snapshot["status"], "status"),
                    simulated_time=float(snapshot["simulated_time"]),
                    speed=Decimal(snapshot["speed"]),
                    makespan=_int(snapshot["makespan"], "makespan"),
                    observed_at=_aware(snapshot["observed_at"], "observed_at"),
                ),
            )
        except (KeyError, TypeError, ValueError, InvalidOperation) as error:
            if isinstance(error, UnsupportedEnvelope):
                raise
            raise UnsupportedEnvelope(f"Malformed envelope: {error}") from error


def _int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise UnsupportedEnvelope(f"{field} is not an integer.")
    return int(value)


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise UnsupportedEnvelope(f"{field} is not a non-empty string.")
    return value


def _aware(value: Any, field: str) -> datetime:
    parsed = datetime.fromisoformat(_text(value, field))
    if parsed.tzinfo is None:
        raise UnsupportedEnvelope(f"{field} has no timezone.")
    return parsed


__all__ = [
    "CAUSES",
    "ENVELOPE_VERSION",
    "SIMULATION_CHANGED",
    "LiveUpdateCause",
    "SimulationAnchor",
    "SimulationChangedEnvelope",
    "UnsupportedEnvelope",
]
