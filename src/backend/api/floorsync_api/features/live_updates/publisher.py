"""Best-effort immediate delivery of one committed outbox row to Redis.

Called only after the transaction that wrote the row has committed (decision 0017: "the route
publishes the row to Redis only after commit"). A failure here must never fail the control that
was already recorded -- the row stays unpublished and a relay (#148, not yet built) retries it.
"""

from __future__ import annotations

import json
import logging
from uuid import UUID

from redis.exceptions import RedisError
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.features.live_updates.redis_client import (
    SIMULATION_CHANGED_CHANNEL,
    get_redis_client,
)
from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox

logger = logging.getLogger(__name__)


class OutboxPublisher:
    """Publish one committed envelope and mark it published. Never raises."""

    @staticmethod
    async def publish_now(db: AsyncSession, outbox_id: UUID) -> None:
        """Publish `outbox_id`'s payload verbatim, then mark it published.

        Takes the id rather than the envelope so the relay can call the exact same method for a
        row it only knows by id. Silently returns for a row that is already published or has
        vanished (both mean there is nothing left to do), and swallows any Redis error rather than
        raising: the caller's REST response must still report the control that already committed.
        """
        row = await db.get(LiveUpdateOutbox, outbox_id)
        if row is None or row.published_at is not None:
            return

        try:
            await get_redis_client().publish(SIMULATION_CHANGED_CHANNEL, json.dumps(row.payload))
        except RedisError:
            logger.warning(
                "Could not publish outbox row %s to Redis; leaving it for the relay.",
                outbox_id,
                exc_info=True,
            )
            return

        async with db.begin():
            await db.execute(
                update(LiveUpdateOutbox)
                .where(LiveUpdateOutbox.id == outbox_id)
                .values(published_at=func.now())
            )


__all__ = ["OutboxPublisher"]
