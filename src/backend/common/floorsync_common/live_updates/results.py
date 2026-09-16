"""Outcomes of recording a live update.

Enqueuing has no expected failure. The caller holds the change it is announcing inside an open
transaction, so anything that stops the row being written (a sequence collision, a missing
simulation) is a broken invariant and raises, per decision 0004.
"""

from dataclasses import dataclass
from uuid import UUID

from floorsync_common.live_updates.contracts import SimulationChangedEnvelope


@dataclass(frozen=True, slots=True)
class SimulationChangeEnqueued:
    """The notification is written and will commit with the change.

    `outbox_id` is what the immediate publisher marks as published; `envelope` is what it sends.
    """

    outbox_id: UUID
    envelope: SimulationChangedEnvelope


__all__ = ["SimulationChangeEnqueued"]
