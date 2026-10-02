"""Bridge Redis pub/sub into this process's local connection hub (#148).

Runs for the app's lifetime: one subscription to the live channel, routing every envelope that
arrives into `hub` for whichever simulations this process actually has a subscriber for. Never
re-derives or mutates simulation state -- the envelope on the wire already carries everything a
client is shown; this only routes it to the sockets allowed to see it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
from typing import Any, Final

from floorsync_api.features.live_updates.connection_hub import ConnectionHub
from floorsync_api.features.live_updates.redis_client import (
    SIMULATION_CHANGED_CHANNEL,
    get_subscriber_client,
)
from floorsync_common.live_updates.contracts import SimulationChangedEnvelope, UnsupportedEnvelope

logger = logging.getLogger(__name__)

RECONNECT_BASE_SECONDS: Final = 1.0
RECONNECT_MAX_SECONDS: Final = 30.0


def reconnect_delay(failures: int) -> float:
    """Exponential backoff from `RECONNECT_BASE_SECONDS`, capped, with jitter so every instance
    that lost Redis at once does not reconnect in the same instant."""
    ceiling: float = min(RECONNECT_BASE_SECONDS * (2 ** (failures - 1)), RECONNECT_MAX_SECONDS)
    jitter: float = random.uniform(0.5, 1.0)
    return ceiling * jitter


class RedisLiveUpdateSubscriber:
    """Owns one background task for the process's lifetime. Start once, stop once."""

    def __init__(self, hub: ConnectionHub) -> None:
        self._hub = hub
        self._task: asyncio.Task[None] | None = None
        self._failures = 0
        self.dropped_payloads = 0

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
        """Reconnect with bounded, jittered backoff on any failure; never let this task die."""
        while True:
            try:
                await self._listen_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                self._failures += 1
                delay = reconnect_delay(self._failures)
                logger.warning(
                    "Live-update subscriber lost its Redis connection; reconnecting.",
                    extra={"consecutive_failures": self._failures, "retry_in_seconds": delay},
                    exc_info=True,
                )
                await asyncio.sleep(delay)

    async def _listen_once(self) -> None:
        pubsub = get_subscriber_client().pubsub()
        await pubsub.subscribe(SIMULATION_CHANGED_CHANNEL)
        self._failures = 0  # subscribed: the next outage starts its backoff from the beginning
        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                await self.route(message["data"])
        finally:
            await pubsub.unsubscribe(SIMULATION_CHANGED_CHANNEL)
            await pubsub.aclose()  # type: ignore[no-untyped-call]  # untyped in redis-py's stubs

    async def route(self, raw: bytes | str) -> None:
        """Decode one published payload and broadcast it to every subscriber of its simulation.

        Public (not the Redis loop's private detail) so a test, or a future outbox relay
        replaying a missed row, can drive it directly without a real Redis connection.
        """
        envelope = _decode(raw)
        if envelope is None:
            self.dropped_payloads += 1
            return
        await self._broadcast(envelope)

    async def _broadcast(self, envelope: SimulationChangedEnvelope) -> None:
        frame_by_audience: dict[str, dict[str, Any]] = {}
        for key in self._hub.keys_for_simulation(envelope.simulation_id):
            frame = frame_by_audience.setdefault(
                key.audience, _frame(envelope, audience=key.audience)
            )
            await self._hub.broadcast(key, frame)


def _decode(raw: bytes | str) -> SimulationChangedEnvelope | None:
    """Parse one payload, or log it loudly (with its event id when one can be read) and drop it.

    Never silent: a dropped notification is an operational failure someone should see, so it is an
    error-level log carrying the event id and is counted on the subscriber for the health signal.
    """
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("Dropping a live-update payload that is not JSON.", exc_info=True)
        return None
    try:
        return SimulationChangedEnvelope.from_payload(payload)
    except UnsupportedEnvelope:
        event_id = payload.get("event_id") if isinstance(payload, dict) else None
        logger.error(
            "Dropping an unreadable live-update envelope.",
            extra={"event_id": str(event_id) if event_id is not None else None},
            exc_info=True,
        )
        return None


def _frame(envelope: SimulationChangedEnvelope, *, audience: str) -> dict[str, Any]:
    """The outbox's own payload, plus the two things only the delivery layer decides.

    `topic` becomes the socket protocol's `type` -- the two vocabularies happen to share the
    string "simulation.changed", but they are different fields for different readers. `audience`
    does not exist in the envelope at all (decision 0017 point 4: it is audience-free by design).
    """
    payload = envelope.to_payload()
    payload["type"] = payload.pop("topic")
    payload["audience"] = audience
    return payload


__all__ = ["RedisLiveUpdateSubscriber"]
