"""This API process's local registry of subscribed sockets.

Not shared across API instances: Redis pub/sub (via `RedisLiveUpdateSubscriber`) is what makes a
control recorded on instance A reach a client connected to instance B. Each instance runs its own
hub, keyed by exactly what a client is allowed to see, so a broadcast never has to re-check
authorisation at send time.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from typing import Any, Final, Protocol
from uuid import UUID

from floorsync_api.features.live_updates.subscriptions import AudienceScope

logger = logging.getLogger(__name__)

# A healthy browser takes a small frame in milliseconds. A send that has not finished by now is
# stalled on backpressure, and waiting longer would hold up every other socket and every later
# update on this process.
SEND_TIMEOUT_SECONDS: Final = 2.0
# The code `websocket.py` already uses for "timeout or limit"; the client reconnects and recovers
# from the REST snapshot.
SLOW_CONSUMER_CLOSE_CODE: Final = 4408


class SendsJSON(Protocol):
    """What the hub needs from a socket. Starlette's `WebSocket` satisfies both already."""

    async def send_json(self, data: Any) -> None: ...

    async def close(self, code: int = 1000) -> None: ...


@dataclass(frozen=True, slots=True)
class SubscriptionKey:
    """What one group of sockets is allowed to see: one simulation, one audience, one machine.

    An operator's `machine_id` is part of the key rather than a filter applied at send time, so
    two operators on different machines are naturally different keys and a broadcast to one can
    never reach the other by construction.
    """

    simulation_id: UUID
    audience: AudienceScope
    machine_id: UUID | None = None


class ConnectionHub:
    """Track this process's sockets by subscription key and serialise sends to each key.

    Not thread-safe across event loops -- FastAPI's default single-event-loop-per-process model is
    what this relies on, same as every other in-process registry in this codebase.
    """

    def __init__(self) -> None:
        self._sockets: dict[SubscriptionKey, set[SendsJSON]] = {}

    def register(self, key: SubscriptionKey, socket: SendsJSON) -> None:
        self._sockets.setdefault(key, set()).add(socket)

    def unregister(self, key: SubscriptionKey, socket: SendsJSON) -> None:
        sockets = self._sockets.get(key)
        if sockets is None:
            return
        sockets.discard(socket)
        if not sockets:
            del self._sockets[key]

    def unregister_all(self, socket: SendsJSON) -> None:
        """Remove one socket from every key it was subscribed to. Call this once, on disconnect."""
        for key in [key for key, sockets in self._sockets.items() if socket in sockets]:
            self.unregister(key, socket)

    def keys_for_simulation(self, simulation_id: UUID) -> tuple[SubscriptionKey, ...]:
        """Every key this process actually has a subscriber for, on one simulation.

        The subscriber uses this to build only the projections someone is
        listening for, rather than one for every machine that has ever existed.
        """
        return tuple(key for key in self._sockets if key.simulation_id == simulation_id)

    def subscription_count(self) -> int:
        """How many distinct `(simulation, audience, machine)` keys this process is serving."""
        return len(self._sockets)

    def socket_count(self) -> int:
        """How many distinct sockets this process holds, across every key they subscribe to."""
        return len({socket for sockets in self._sockets.values() for socket in sockets})

    async def broadcast(self, key: SubscriptionKey, message: dict[str, Any]) -> None:
        """Send `message` to every socket subscribed to `key`, all at once.

        Each send is bounded by `SEND_TIMEOUT_SECONDS`, and a socket that fails or stalls is dropped
        and closed, so one bad connection can neither stop delivery to the others sharing its key
        nor hold up this process's next update (#148's error contract). Never raises.
        """
        sockets = list(self._sockets.get(key, ()))
        await asyncio.gather(*(self._deliver(key, socket, message) for socket in sockets))

    async def _deliver(
        self, key: SubscriptionKey, socket: SendsJSON, message: dict[str, Any]
    ) -> None:
        try:
            async with asyncio.timeout(SEND_TIMEOUT_SECONDS):
                await socket.send_json(message)
        except Exception:
            logger.warning(
                "Dropping a live-update socket that failed or stalled on a message.",
                extra={"simulation_id": str(key.simulation_id), "audience_scope": key.audience},
                exc_info=True,
            )
            await self._drop(socket)

    async def _drop(self, socket: SendsJSON) -> None:
        """Forget `socket` everywhere and close it, so the client knows to reconnect.

        Merely unregistering would leave a live connection that looks subscribed and receives
        nothing: its heartbeats would still be answered, so the client would never notice.
        """
        self.unregister_all(socket)
        with contextlib.suppress(Exception):
            async with asyncio.timeout(SEND_TIMEOUT_SECONDS):
                await socket.close(code=SLOW_CONSUMER_CLOSE_CODE)


__all__ = ["ConnectionHub", "SendsJSON", "SubscriptionKey"]
