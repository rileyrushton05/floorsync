"""The `/ws` endpoint: the single socket every live-update client connects to (#148).

The server accepts the upgrade, then requires an `authenticate` frame carrying a one-time ticket
within `AUTH_TIMEOUT_SECONDS`. Once authenticated, `subscribe`/`unsubscribe` join or leave one
simulation's audience-scoped group, and `ping` is answered with `pong`. This module decides
nothing about who is allowed to see what -- that is `LiveSubscriptionAuthorizer`'s job; this module
only enforces the protocol shape and maps every failure to a specific close code.

An idle connection (no frame at all, authenticated or not) is closed after
`IDLE_TIMEOUT_SECONDS`, which doubles as the heartbeat: a client that stops sending `ping` looks
identical to one that vanished, and is treated the same way.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final
from uuid import UUID, uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from floorsync_api.features.live_updates.connection_hub import ConnectionHub, SubscriptionKey
from floorsync_api.features.live_updates.snapshots import (
    LiveUpdateSnapshotService,
    SnapshotUnavailable,
)
from floorsync_api.features.live_updates.subscriptions import (
    LiveSubscriptionAuthorizer,
    SubscriptionGranted,
)
from floorsync_api.features.live_updates.tickets import LiveUpdateTicketService
from floorsync_common.database.session import session_scope

logger = logging.getLogger(__name__)

router = APIRouter(tags=["live-updates"])

PROTOCOL_VERSION: Final = 1
AUTH_TIMEOUT_SECONDS: Final = 5
IDLE_TIMEOUT_SECONDS: Final = 25
MAX_FRAME_BYTES: Final = 64 * 1024
MAX_SUBSCRIPTIONS_PER_CONNECTION: Final = 10

CLOSE_MALFORMED_FRAME: Final = 4400
CLOSE_INVALID_TICKET: Final = 4401
CLOSE_FORBIDDEN: Final = 4403
CLOSE_TIMEOUT_OR_LIMIT: Final = 4408

# One hub per process: every socket this instance holds is registered here. Cross-instance
# delivery is the Redis subscriber's job (not yet built), which republishes into this same hub.
hub = ConnectionHub()


class _Closed(Exception):
    """Raised once this module has already sent a WebSocket close frame, to unwind the loop."""


@dataclass
class _ConnectionState:
    """What one socket has proven about itself, mutated as the protocol progresses."""

    user_id: UUID | None = None
    keys: set[SubscriptionKey] = field(default_factory=set)


@router.websocket("/ws")
async def live_updates(websocket: WebSocket) -> None:
    await websocket.accept()
    state = _ConnectionState()
    try:
        await _authenticate(websocket, state)
        while True:
            frame = await _receive_frame(websocket)
            await _handle_frame(websocket, state, frame)
    except (_Closed, WebSocketDisconnect):
        pass
    finally:
        for key in state.keys:
            hub.unregister(key, websocket)


async def _authenticate(websocket: WebSocket, state: _ConnectionState) -> None:
    """Require an `authenticate` frame within `AUTH_TIMEOUT_SECONDS`, or close 4408/4401/4400."""
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=AUTH_TIMEOUT_SECONDS)
    except TimeoutError:
        await websocket.close(code=CLOSE_TIMEOUT_OR_LIMIT)
        raise _Closed from None

    frame = _parse_frame(raw)
    if frame is None or frame.get("type") != "authenticate":
        await websocket.close(code=CLOSE_MALFORMED_FRAME)
        raise _Closed

    ticket = frame.get("ticket")
    if not isinstance(ticket, str):
        await websocket.close(code=CLOSE_MALFORMED_FRAME)
        raise _Closed

    user_id = await LiveUpdateTicketService.consume(ticket)
    if user_id is None:
        await websocket.close(code=CLOSE_INVALID_TICKET)
        raise _Closed

    state.user_id = user_id
    await websocket.send_json(
        {
            "v": PROTOCOL_VERSION,
            "type": "authenticated",
            "connection_id": str(uuid4()),
            "server_time": _now_iso(),
        }
    )


async def _receive_frame(websocket: WebSocket) -> dict[str, Any]:
    """Read one client frame, or close the socket and unwind for every way that can fail."""
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=IDLE_TIMEOUT_SECONDS)
    except TimeoutError:
        await websocket.close(code=CLOSE_TIMEOUT_OR_LIMIT)
        raise _Closed from None

    frame = _parse_frame(raw)
    if frame is None:
        await websocket.close(code=CLOSE_MALFORMED_FRAME)
        raise _Closed
    return frame


def _parse_frame(raw: str) -> dict[str, Any] | None:
    """Return the decoded frame, or `None` for anything that is not a valid v1 envelope."""
    if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
        return None
    try:
        frame = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(frame, dict) or frame.get("v") != PROTOCOL_VERSION or "type" not in frame:
        return None
    return frame


async def _handle_frame(
    websocket: WebSocket, state: _ConnectionState, frame: dict[str, Any]
) -> None:
    frame_type = frame.get("type")
    if frame_type == "ping":
        await websocket.send_json(
            {"v": PROTOCOL_VERSION, "type": "pong", "server_time": _now_iso()}
        )
        return
    if frame_type == "subscribe":
        await _subscribe(websocket, state, frame)
        return
    if frame_type == "unsubscribe":
        _unsubscribe(websocket, state, frame)
        return
    await websocket.close(code=CLOSE_MALFORMED_FRAME)
    raise _Closed


async def _subscribe(websocket: WebSocket, state: _ConnectionState, frame: dict[str, Any]) -> None:
    simulation_id = _parse_simulation_id(frame)
    if simulation_id is None:
        await websocket.close(code=CLOSE_MALFORMED_FRAME)
        raise _Closed

    if len(state.keys) >= MAX_SUBSCRIPTIONS_PER_CONNECTION:
        await websocket.close(code=CLOSE_TIMEOUT_OR_LIMIT)
        raise _Closed

    assert state.user_id is not None, "_authenticate must complete before any frame is handled"

    async with session_scope() as db:
        result = await LiveSubscriptionAuthorizer.authorize(
            db, user_id=state.user_id, simulation_id=simulation_id
        )
        if not isinstance(result, SubscriptionGranted):
            await websocket.close(code=CLOSE_FORBIDDEN)
            raise _Closed

        key = SubscriptionKey(
            simulation_id=simulation_id, audience=result.audience, machine_id=result.machine_id
        )
        hub.register(key, websocket)
        state.keys.add(key)

        snapshot = await LiveUpdateSnapshotService.build(
            db, simulation_id=simulation_id, audience=result.audience
        )

    if isinstance(snapshot, SnapshotUnavailable):
        # Subscribed, but nothing to show yet (the schedule has no entries). Not a protocol
        # error -- the client simply waits for the first `simulation.changed` frame.
        return
    await websocket.send_json(snapshot)


def _unsubscribe(websocket: WebSocket, state: _ConnectionState, frame: dict[str, Any]) -> None:
    """Leave every key this connection holds for the named simulation.

    A subscription's audience/machine were decided by the server at subscribe time, and the
    client was never told them, so it can only ever ask to leave a simulation, not a specific key.
    """
    simulation_id = _parse_simulation_id(frame)
    if simulation_id is None:
        return
    for key in [key for key in state.keys if key.simulation_id == simulation_id]:
        hub.unregister(key, websocket)
        state.keys.discard(key)


def _parse_simulation_id(frame: dict[str, Any]) -> UUID | None:
    raw = frame.get("simulation_id")
    if not isinstance(raw, str):
        return None
    try:
        return UUID(raw)
    except ValueError:
        return None


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


__all__ = ["hub", "router"]
