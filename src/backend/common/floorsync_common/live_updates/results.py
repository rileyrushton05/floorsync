"""Outcomes of recording and delivering a live update.

Enqueuing has no expected failure. The caller holds the change it is announcing inside an open
transaction, so anything that stops the row being written (a sequence collision, a missing
simulation) is a broken invariant and raises, per decision 0004.

Delivery has one expected outcome besides success: the row was already settled. The immediate
publisher and the relay can race for the same row, and a row can be pruned, so "nothing left to
mark" is normal rather than an error.
"""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from floorsync_common.live_updates.contracts import SimulationChangedEnvelope


@dataclass(frozen=True, slots=True)
class SimulationChangeEnqueued:
    """The notification is written and will commit with the change.

    `outbox_id` is what the immediate publisher marks as published; `envelope` is what it sends.
    """

    outbox_id: UUID
    envelope: SimulationChangedEnvelope


@dataclass(frozen=True, slots=True)
class OutboxRowPublished:
    """This call marked the row published."""

    outbox_id: UUID


@dataclass(frozen=True, slots=True)
class OutboxRowAlreadySettled:
    """The row was already published by another path, or no longer exists. Nothing to do."""

    outbox_id: UUID


type MarkPublishedResult = OutboxRowPublished | OutboxRowAlreadySettled


@dataclass(frozen=True, slots=True)
class OutboxBacklog:
    """How much is still owed to Redis, for the live-delivery health signal.

    `oldest_created_at` is `None` exactly when `unpublished_count` is zero.
    """

    unpublished_count: int
    oldest_created_at: datetime | None


__all__ = [
    "MarkPublishedResult",
    "OutboxBacklog",
    "OutboxRowAlreadySettled",
    "OutboxRowPublished",
    "SimulationChangeEnqueued",
]
