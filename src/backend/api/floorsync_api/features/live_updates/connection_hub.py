"""This API process's local registry of subscribed sockets.

Not shared across API instances: Redis pub/sub (via `RedisLiveUpdateSubscriber`) is what makes a
control recorded on instance A reach a client connected to instance B. Each instance runs its own
hub, keyed by exactly what a client is allowed to see, so a broadcast never has to re-check
authorisation at send time.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from floorsync_api.features.live_updates.subscriptions import AudienceScope

logger = logging.getLogger(__name__)


class SendsJSON(Protocol):
    """The one method the hub needs from a socket. `WebSocket.send_json` satisfies this already."""

    async def send_json(self, data: Any) -> None: ...


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
        """Send `message` to every socket subscribed to `key`.

        A send failure drops that socket only -- per #148's error contract, one dead connection
        must never stop delivery to the others sharing its key.
        """
        for socket in list(self._sockets.get(key, ())):
            try:
                await socket.send_json(message)
            except Exception:
                logger.warning(
                    "Dropping a live-update socket that failed to receive a message.",
                    extra={"simulation_id": str(key.simulation_id), "audience_scope": key.audience},
                    exc_info=True,
                )
                self.unregister(key, socket)


__all__ = ["ConnectionHub", "SendsJSON", "SubscriptionKey"]
