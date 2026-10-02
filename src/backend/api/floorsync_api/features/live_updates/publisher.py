"""Best-effort immediate delivery of one committed outbox row to Redis.

Called only after the transaction that wrote the row has committed (decision 0017: "the route
publishes the row to Redis only after commit"). A failure here must never fail the control that
was already recorded -- the row stays unpublished and the relay retries it.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any, assert_never
from uuid import UUID

from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.features.live_updates.redis_client import (
    SIMULATION_CHANGED_CHANNEL,
    get_redis_client,
)
from floorsync_common.live_updates.contracts import SimulationChangedEnvelope, UnsupportedEnvelope
from floorsync_common.live_updates.results import OutboxRowAlreadySettled, OutboxRowPublished
from floorsync_common.live_updates.service import LiveUpdateOutboxService

logger = logging.getLogger(__name__)


def is_publishable(payload: Any) -> bool:
    """Whether `payload` is an envelope subscribers will accept.

    Checked before sending so a broken row is reported at the source, with its event id, instead of
    being published and then dropped by every subscriber.
    """
    try:
        SimulationChangedEnvelope.from_payload(payload)
    except UnsupportedEnvelope:
        return False
    return True


class OutboxPublisher:
    """Publish one committed envelope and mark it published. Never raises."""

    @staticmethod
    async def publish_now(db: AsyncSession, outbox_id: UUID) -> None:
        """Publish `outbox_id`'s payload verbatim, then mark it published.

        Takes the id rather than the envelope so the relay can call the exact same method for a
        row it only knows by id. Silently returns for a row that is already published or has
        vanished (both mean there is nothing left to do), and swallows any Redis error rather than
        raising: the caller's REST response must still report the control that already committed.

        `db` arrives here right after the caller's own `db.begin()` block has already closed, and
        this session's `autobegin=False` means any statement outside an explicit `begin()` raises
        -- so even the read needs its own transaction, not just the mark-published write.
        """
        async with db.begin():
            row = await LiveUpdateOutboxService.load_unpublished(db, outbox_id)
            if row is None:
                return
            if not is_publishable(row.payload):
                logger.error(
                    "Outbox row %s holds an unreadable envelope; not publishing it.",
                    outbox_id,
                    extra={"outbox_id": str(outbox_id)},
                )
                return
            payload = json.dumps(row.payload)

        try:
            await get_redis_client().publish(SIMULATION_CHANGED_CHANNEL, payload)
        except RedisError:
            logger.warning(
                "Could not publish outbox row %s to Redis; leaving it for the relay.",
                outbox_id,
                extra={"outbox_id": str(outbox_id)},
                exc_info=True,
            )
            return

        async with db.begin():
            result = await LiveUpdateOutboxService.mark_published(
                db, outbox_id, at=datetime.now(UTC)
            )
        match result:
            case OutboxRowPublished() | OutboxRowAlreadySettled():
                # The relay may have published and marked it first; either way nothing is owed.
                pass
            case _:
                assert_never(result)


__all__ = ["OutboxPublisher"]
