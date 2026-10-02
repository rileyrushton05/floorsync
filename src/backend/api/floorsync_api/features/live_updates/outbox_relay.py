"""Retry any outbox row that immediate publish missed (#148).

Redis pub/sub is fire-and-forget: a row can commit but never actually reach Redis if the
immediate publish attempt failed (Redis was down, or the process crashed between commit and
publish -- see `OutboxPublisher`). This relay is the durable second path: it claims due,
unpublished rows (`LiveUpdateOutboxService.claim_due`, `FOR UPDATE SKIP LOCKED`, so more than one
relay can run at once), and retries each with a doubling backoff so a Redis outage does not turn
into a tight retry loop. All SQL lives in the outbox service; this module owns Redis and timing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Final, assert_never

from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.features.live_updates.publisher import is_publishable
from floorsync_api.features.live_updates.redis_client import (
    SIMULATION_CHANGED_CHANNEL,
    get_redis_client,
)
from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox
from floorsync_common.database.session import session_scope
from floorsync_common.live_updates.results import OutboxRowAlreadySettled, OutboxRowPublished
from floorsync_common.live_updates.service import LiveUpdateOutboxService

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS: Final = 2.0
BATCH_SIZE: Final = 50
BASE_BACKOFF_SECONDS: Final = 2.0
MAX_BACKOFF_SECONDS: Final = 300.0


class OutboxRelay:
    """Owns one background task for the process's lifetime. Start once, stop once."""

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run_forever())

    @property
    def running(self) -> bool:
        """`False` once `stop()` completes, or if the background task died without one."""
        return self._task is not None and not self._task.done()

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    async def _run_forever(self) -> None:
        """Drain a backlog without waiting between full batches; idle at `POLL_INTERVAL_SECONDS`
        once a pass claims nothing. A failed pass never kills this loop -- it logs and retries."""
        while True:
            try:
                claimed = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("Outbox relay pass failed; retrying next interval.", exc_info=True)
                claimed = 0
            await asyncio.sleep(0 if claimed >= BATCH_SIZE else POLL_INTERVAL_SECONDS)

    async def run_once(self) -> int:
        """Claim and retry one batch of due rows. Returns how many it handled.

        Public so a test, or an operator, can drive one pass without waiting on the poll loop.

        The first Redis failure ends the batch. Redis is down or hanging for every row, so trying
        the rest would only wait out one timeout each while holding their row locks; they are
        released untouched when this transaction ends and are claimed again on the next pass.
        """
        async with session_scope() as db:
            rows = await LiveUpdateOutboxService.claim_due(
                db, now=datetime.now(UTC), limit=BATCH_SIZE
            )
            handled = 0
            for row in rows:
                handled += 1
                if not await _retry(db, row):
                    break
            return handled


async def _retry(db: AsyncSession, row: LiveUpdateOutbox) -> bool:
    """Publish one claimed row, then settle it: mark it published, or hold it back and say why.

    `False` means Redis itself failed (the caller should stop the batch); an unreadable row is
    parked and still returns `True`, since the next row may be fine.
    """
    if not is_publishable(row.payload):
        # Retrying cannot fix a malformed payload, so park it for the longest backoff and record why
        # instead of publishing something every subscriber would drop. It stays visible in the
        # outbox backlog (count and age) until someone repairs or prunes it.
        await LiveUpdateOutboxService.record_failure(
            db,
            row.id,
            error_code="UnsupportedEnvelope",
            retry_at=datetime.now(UTC) + timedelta(seconds=MAX_BACKOFF_SECONDS),
        )
        event_id = row.payload.get("event_id") if isinstance(row.payload, dict) else None
        logger.error(
            "Outbox row %s holds an unreadable envelope; parked, not published.",
            row.id,
            extra={
                "outbox_id": str(row.id),
                "event_id": str(event_id) if event_id is not None else None,
                "error_code": "UnsupportedEnvelope",
            },
        )
        return True

    try:
        await get_redis_client().publish(SIMULATION_CHANGED_CHANNEL, json.dumps(row.payload))
    except RedisError as error:
        attempt_count = row.attempt_count + 1
        error_code = type(error).__name__
        await LiveUpdateOutboxService.record_failure(
            db,
            row.id,
            error_code=error_code,
            retry_at=datetime.now(UTC) + _backoff(attempt_count),
        )
        logger.warning(
            "Outbox row %s failed to publish; will retry.",
            row.id,
            extra={
                "outbox_id": str(row.id),
                "attempt_count": attempt_count,
                "error_code": error_code,
            },
            exc_info=True,
        )
        return False

    result = await LiveUpdateOutboxService.mark_published(db, row.id, at=datetime.now(UTC))
    match result:
        case OutboxRowPublished() | OutboxRowAlreadySettled():
            pass
        case _:
            assert_never(result)
    return True


def _backoff(attempt_count: int) -> timedelta:
    """Doubling delay from `BASE_BACKOFF_SECONDS`, capped at `MAX_BACKOFF_SECONDS`."""
    seconds = min(BASE_BACKOFF_SECONDS * (2 ** (attempt_count - 1)), MAX_BACKOFF_SECONDS)
    return timedelta(seconds=seconds)


__all__ = ["OutboxRelay"]
