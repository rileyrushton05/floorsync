"""Best-effort immediate delivery of one committed outbox row to Redis.

Called only after the transaction that wrote the row has committed (decision 0017: "the route
publishes the row to Redis only after commit"). A failure here must never fail the control that
was already recorded -- the row stays unpublished and the relay retries it.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import assert_never
from uuid import UUID

from floorsync_api.features.live_updates.delivery import (
    Delivered,
    PayloadUnreadable,
    RedisRefused,
    deliver,
)
from floorsync_common.database.session import session_scope
from floorsync_common.live_updates.results import OutboxRowAlreadySettled, OutboxRowPublished
from floorsync_common.live_updates.service import LiveUpdateOutboxService

logger = logging.getLogger(__name__)


class OutboxPublisher:
    """Publish one committed envelope and mark it published, without ever failing the caller."""

    @staticmethod
    async def publish_now(outbox_id: UUID) -> None:
        """Best-effort immediate delivery of a row that has already committed.

        Any failure, Redis or the database, is logged and leaves the durable row for the relay:
        the caller's response must still report the control that already committed, and an error
        here would invite a retry of an action that was applied. Only cancellation escapes.

        It opens its own sessions rather than borrowing the caller's. A failed transaction on the
        caller's session would roll back and expire every object it had loaded, and with
        `autobegin=False` the caller's next attribute read (building its response) would raise.
        """
        try:
            await OutboxPublisher._publish(outbox_id)
        except Exception:
            logger.warning(
                "Immediate publish of outbox row %s failed; leaving it for the relay.",
                outbox_id,
                extra={"outbox_id": str(outbox_id)},
                exc_info=True,
            )

    @staticmethod
    async def _publish(outbox_id: UUID) -> None:
        async with session_scope() as db:
            row = await LiveUpdateOutboxService.load_unpublished(db, outbox_id)
            if row is None:
                return
            payload = row.payload

        result = await deliver(payload)
        match result:
            case Delivered():
                pass
            case PayloadUnreadable(event_id=event_id):
                logger.error(
                    "Outbox row %s holds an unreadable envelope; not publishing it.",
                    outbox_id,
                    extra={"outbox_id": str(outbox_id), "event_id": event_id},
                )
                return
            case RedisRefused(error=error):
                logger.warning(
                    "Could not publish outbox row %s to Redis; leaving it for the relay.",
                    outbox_id,
                    extra={"outbox_id": str(outbox_id)},
                    exc_info=error,
                )
                return
            case _:
                assert_never(result)

        async with session_scope() as db:
            marked = await LiveUpdateOutboxService.mark_published(
                db, outbox_id, at=datetime.now(UTC)
            )
        match marked:
            case OutboxRowPublished() | OutboxRowAlreadySettled():
                # The relay may have published and marked it first; either way nothing is owed.
                pass
            case _:
                assert_never(marked)


__all__ = ["OutboxPublisher"]
