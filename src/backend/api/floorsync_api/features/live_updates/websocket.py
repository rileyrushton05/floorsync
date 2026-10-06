"""The `/ws` endpoint: the single socket every live-update client connects to (#148).

Enforces the protocol shape only: an `authenticate` frame with a one-time ticket within
`AUTH_TIMEOUT_SECONDS`, then `subscribe`/`unsubscribe`/`ping`, with every failure mapped to a
specific close code. Who may see what is `LiveSubscriptionAuthorizer`'s decision, not this module's.

A connection that sends nothing for `IDLE_TIMEOUT_SECONDS` is closed; that doubles as the
heartbeat, since a client that stops pinging looks the same as one that vanished.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final, NoReturn, assert_never
from uuid import UUID, uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis.exceptions import RedisError

from floorsync_api.features.live_updates.connection_hub import ConnectionHub, SubscriptionKey
from floorsync_api.features.live_updates.rate_limit import check_account, check_ip
from floorsync_api.features.live_updates.snapshots import (
    LiveUpdateSnapshotService,
    SnapshotUnavailable,
)
from floorsync_api.features.live_updates.subscriptions import (
    LiveSubscriptionAuthorizer,
    SubscriptionGranted,
    SubscriptionRefused,
)
from floorsync_api.features.live_updates.tickets import LiveUpdateTicketService
from floorsync_common.database.session import session_scope
from floorsync_common.observability import reset_request_id, set_request_id

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
# The standard "try again later": Redis (tickets, rate limits) is unavailable, so the client
# should fall back to polling the REST snapshot and retry the socket later.
CLOSE_TRY_AGAIN_LATER: Final = 1013

# One hub per process: every socket this instance holds is registered here. Cross-instance
# delivery is `RedisLiveUpdateSubscriber`'s job, which republishes into this same hub.
hub = ConnectionHub()


class _Closed(Exception):
    """Raised once this module has already sent a WebSocket close frame, to unwind the loop."""


async def _close(websocket: WebSocket, state: _ConnectionState, code: int, reason: str) -> NoReturn:
    """Close with `code`, logging `reason` with it, so a reported disconnect can be told apart from
    a deliberate protocol rejection."""
    logger.info(
        "Live-update connection closing.",
        extra={
            "connection_id": str(state.connection_id),
            "actor_user_id": str(state.user_id) if state.user_id is not None else None,
            "close_code": code,
            "reason": reason,
        },
    )
    await websocket.close(code=code)
    raise _Closed


@dataclass
class _ConnectionState:
    """What one socket has proven about itself, mutated as the protocol progresses."""

    connection_id: UUID = field(default_factory=uuid4)
    user_id: UUID | None = None
    keys: set[SubscriptionKey] = field(default_factory=set)


@router.websocket("/ws")
async def live_updates(websocket: WebSocket) -> None:
    await websocket.accept()
    state = _ConnectionState()
    # The request-context middleware only covers HTTP, so a socket's logs would carry no
    # correlation id. The connection id is the socket's equivalent.
    request_id_token = set_request_id(str(state.connection_id))
    try:
        try:
            if not await check_ip(_client_ip(websocket)):
                await _close(websocket, state, CLOSE_TIMEOUT_OR_LIMIT, "ip_rate_limited")
            await _authenticate(websocket, state)
        except RedisError:
            logger.warning(
                "Redis is unavailable during the live-update handshake.",
                extra={"connection_id": str(state.connection_id)},
                exc_info=True,
            )
            await _close(websocket, state, CLOSE_TRY_AGAIN_LATER, "redis_unavailable")
        while True:
            frame = await _receive_frame(websocket, state)
            await _handle_frame(websocket, state, frame)
    except (_Closed, WebSocketDisconnect):
        pass
    finally:
        for key in state.keys:
            hub.unregister(key, websocket)
        reset_request_id(request_id_token)


async def _authenticate(websocket: WebSocket, state: _ConnectionState) -> None:
    """Require an `authenticate` frame within `AUTH_TIMEOUT_SECONDS`, or close 4408/4401/4400."""
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=AUTH_TIMEOUT_SECONDS)
    except TimeoutError:
        await _close(websocket, state, CLOSE_TIMEOUT_OR_LIMIT, "auth_timeout")

    frame = _parse_frame(raw)
    if frame is None or frame.get("type") != "authenticate":
        await _close(websocket, state, CLOSE_MALFORMED_FRAME, "malformed_auth_frame")

    ticket = frame.get("ticket")
    if not isinstance(ticket, str):
        await _close(websocket, state, CLOSE_MALFORMED_FRAME, "malformed_auth_frame")

    user_id = await LiveUpdateTicketService.consume(ticket)
    if user_id is None:
        await _close(websocket, state, CLOSE_INVALID_TICKET, "invalid_ticket")

    if not await check_account(user_id):
        await _close(websocket, state, CLOSE_TIMEOUT_OR_LIMIT, "account_rate_limited")

    state.user_id = user_id
    logger.info(
        "Live-update connection authenticated.",
        extra={"connection_id": str(state.connection_id), "actor_user_id": str(user_id)},
    )
    await websocket.send_json(
        {
            "v": PROTOCOL_VERSION,
            "type": "authenticated",
            "connection_id": str(state.connection_id),
            "server_time": _now_iso(),
        }
    )


async def _receive_frame(websocket: WebSocket, state: _ConnectionState) -> dict[str, Any]:
    """Read one client frame, or close the socket and unwind for every way that can fail."""
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=IDLE_TIMEOUT_SECONDS)
    except TimeoutError:
        await _close(websocket, state, CLOSE_TIMEOUT_OR_LIMIT, "idle_timeout")

    frame = _parse_frame(raw)
    if frame is None:
        await _close(websocket, state, CLOSE_MALFORMED_FRAME, "malformed_frame")
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
    await _close(websocket, state, CLOSE_MALFORMED_FRAME, "unknown_frame_type")


async def _subscribe(websocket: WebSocket, state: _ConnectionState, frame: dict[str, Any]) -> None:
    simulation_id = _parse_simulation_id(frame)
    if simulation_id is None:
        await _close(websocket, state, CLOSE_MALFORMED_FRAME, "malformed_subscribe_frame")

    if len(state.keys) >= MAX_SUBSCRIPTIONS_PER_CONNECTION:
        await _close(websocket, state, CLOSE_TIMEOUT_OR_LIMIT, "subscription_limit")

    assert state.user_id is not None, "_authenticate must complete before any frame is handled"

    async with session_scope() as db:
        result = await LiveSubscriptionAuthorizer.authorize(
            db, user_id=state.user_id, simulation_id=simulation_id
        )
        match result:
            case SubscriptionGranted():
                pass
            case SubscriptionRefused():
                await _close(websocket, state, CLOSE_FORBIDDEN, "subscription_refused")
            case _:
                assert_never(result)

        key = SubscriptionKey(
            simulation_id=simulation_id, audience=result.audience, machine_id=result.machine_id
        )
        hub.register(key, websocket)
        state.keys.add(key)
        logger.info(
            "Live-update subscription granted.",
            extra={
                "connection_id": str(state.connection_id),
                "actor_user_id": str(state.user_id),
                "simulation_id": str(simulation_id),
                "audience_scope": result.audience,
            },
        )

        snapshot = await LiveUpdateSnapshotService.build(
            db, simulation_id=simulation_id, audience=result.audience
        )

    match snapshot:
        case SnapshotUnavailable():
            # Subscribed, but nothing to show yet (the schedule has no entries). Not a protocol
            # error -- the client simply waits for the first `simulation.changed` frame.
            return
        case dict():
            await websocket.send_json(snapshot)
        case _:
            assert_never(snapshot)


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


def _client_ip(websocket: WebSocket) -> str:
    """The ASGI peer address. Nothing in this codebase trusts a forwarded-for header today, so a
    caller behind an untrusted proxy is rate-limited by the proxy's address, not its own."""
    return websocket.client.host if websocket.client is not None else "unknown"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


__all__ = ["hub", "router"]
