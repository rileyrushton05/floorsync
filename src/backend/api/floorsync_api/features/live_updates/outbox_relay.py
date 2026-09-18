"""Retry any outbox row that immediate publish missed (#148).

Redis pub/sub is fire-and-forget: a row can commit but never actually reach Redis if the
immediate publish attempt failed (Redis was down, or the process crashed between commit and
publish -- see `OutboxPublisher`). This relay is the durable second path: it claims due,
unpublished rows with `SELECT ... FOR UPDATE SKIP LOCKED`, safe with more than one relay running
at once since a locked row is simply skipped rather than contended for, and retries each with a
doubling backoff so a Redis outage does not turn into a tight retry loop.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Final

from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.features.live_updates.redis_client import (
    SIMULATION_CHANGED_CHANNEL,
    get_redis_client,
)
from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox
from floorsync_common.database.session import session_scope

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
        """Claim and retry one batch of due rows. Returns how many were claimed.

        Public so a test, or an operator, can drive one pass without waiting on the poll loop.
        """
        async with session_scope() as db:
            rows = (
                await db.scalars(
                    select(LiveUpdateOutbox)
                    .where(
                        LiveUpdateOutbox.published_at.is_(None),
                        LiveUpdateOutbox.next_attempt_at <= datetime.now(UTC),
                    )
                    .order_by(LiveUpdateOutbox.next_attempt_at, LiveUpdateOutbox.created_at)
                    .limit(BATCH_SIZE)
                    .with_for_update(skip_locked=True)
                )
            ).all()

            for row in rows:
                await _retry(db, row)

            return len(rows)


async def _retry(db: AsyncSession, row: LiveUpdateOutbox) -> None:
    """Publish one claimed row; on failure, push its next attempt out and record why.

    `db` is unused directly -- `row` is already an object this transaction owns via the row lock
    `run_once` took, so mutating it is enough for the surrounding `session_scope()` to persist the
    change on commit. It stays a parameter so a test can construct `_retry` calls independent of a
    real session, matching how the rest of this module is exercised without a database.
    """
    try:
        await get_redis_client().publish(SIMULATION_CHANGED_CHANNEL, json.dumps(row.payload))
    except RedisError as error:
        row.attempt_count += 1
        row.next_attempt_at = datetime.now(UTC) + _backoff(row.attempt_count)
        row.last_error_code = type(error).__name__
        logger.warning("Outbox row %s failed to publish; will retry.", row.id, exc_info=True)
        return
    row.published_at = datetime.now(UTC)


def _backoff(attempt_count: int) -> timedelta:
    """Doubling delay from `BASE_BACKOFF_SECONDS`, capped at `MAX_BACKOFF_SECONDS`."""
    seconds = min(BASE_BACKOFF_SECONDS * (2 ** (attempt_count - 1)), MAX_BACKOFF_SECONDS)
    return timedelta(seconds=seconds)


__all__ = ["OutboxRelay"]
