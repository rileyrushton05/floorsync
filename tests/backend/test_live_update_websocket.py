"""The `/ws` protocol (#148): frame validation, auth, subscribe/unsubscribe, and close codes.

`LiveUpdateTicketService`, `LiveSubscriptionAuthorizer`, and `LiveUpdateSnapshotService` all have
their own tests; every test here stubs them and `session_scope` (opening a real database
connection is neither needed nor available in this suite) to isolate the protocol state machine
itself -- timeouts, frame shape, and which close code each failure maps to.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI, WebSocketDisconnect
from fastapi.testclient import TestClient

from floorsync_api.features.live_updates import websocket as websocket_module
from floorsync_api.features.live_updates.snapshots import SnapshotUnavailable
from floorsync_api.features.live_updates.subscriptions import (
    SubscriptionGranted,
    SubscriptionRefused,
)
from floorsync_api.features.live_updates.tickets import LiveUpdateTicketService
from floorsync_api.features.live_updates.websocket import (
    CLOSE_FORBIDDEN,
    CLOSE_INVALID_TICKET,
    CLOSE_MALFORMED_FRAME,
    CLOSE_TIMEOUT_OR_LIMIT,
    MAX_SUBSCRIPTIONS_PER_CONNECTION,
    hub,
    router,
)

SIMULATION_ID = UUID("22222222-2222-4222-8222-222222222222")
USER_ID = UUID("11111111-1111-4111-8111-111111111111")


@pytest.fixture(autouse=True)
def _fake_db(monkeypatch: pytest.MonkeyPatch) -> None:
    """`_subscribe` opens its own session; nothing in these tests ever queries through it."""

    @asynccontextmanager
    async def fake_session_scope() -> Any:
        yield object()

    monkeypatch.setattr(websocket_module, "session_scope", fake_session_scope)


@pytest.fixture(autouse=True)
def _fast_timeouts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink the real timeouts so a test that waits for one takes milliseconds, not seconds."""

    monkeypatch.setattr(websocket_module, "AUTH_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(websocket_module, "IDLE_TIMEOUT_SECONDS", 0.05)


@pytest.fixture(autouse=True)
def _allow_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rate limiting has its own tests; every other test here needs it out of the way."""

    async def allow(*_: object, **__: object) -> bool:
        return True

    monkeypatch.setattr(websocket_module, "check_ip", allow)
    monkeypatch.setattr(websocket_module, "check_account", allow)


def _stub_consume(monkeypatch: pytest.MonkeyPatch, outcome: UUID | None) -> None:
    async def fake(_ticket: str) -> UUID | None:
        return outcome

    monkeypatch.setattr(LiveUpdateTicketService, "consume", staticmethod(fake))


def _stub_authorize(monkeypatch: pytest.MonkeyPatch, outcome: object) -> None:
    async def fake(*_: object, **__: object) -> object:
        return outcome

    monkeypatch.setattr(
        websocket_module.LiveSubscriptionAuthorizer, "authorize", staticmethod(fake)
    )


def _stub_snapshot(monkeypatch: pytest.MonkeyPatch, outcome: object) -> None:
    async def fake(*_: object, **__: object) -> object:
        return outcome

    monkeypatch.setattr(websocket_module.LiveUpdateSnapshotService, "build", staticmethod(fake))


def ws_client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _snapshot_frame() -> dict[str, Any]:
    return {
        "v": 1,
        "type": "simulation.snapshot",
        "event_id": str(uuid4()),
        "simulation_id": str(SIMULATION_ID),
        "sequence": 1,
        "occurred_at": datetime.now(UTC).isoformat(),
        "audience": "manager_floor",
        "snapshot": {
            "status": "running",
            "simulated_time": 1.0,
            "speed": "1.00",
            "makespan": 10,
            "observed_at": datetime.now(UTC).isoformat(),
        },
    }


# -- authentication ---------------------------------------------------------------------------


def test_a_valid_ticket_is_greeted_with_authenticated(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_consume(monkeypatch, USER_ID)

    with ws_client().websocket_connect("/ws") as ws:
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        frame = ws.receive_json()

    assert frame["type"] == "authenticated"
    assert frame["v"] == 1
    assert "connection_id" in frame
    assert "server_time" in frame


def test_an_invalid_ticket_closes_4401(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_consume(monkeypatch, None)

    with ws_client().websocket_connect("/ws") as ws:
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "stale-or-unknown"})
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()

    assert exc_info.value.code == CLOSE_INVALID_TICKET


def test_no_auth_frame_within_the_timeout_closes_4408() -> None:
    with ws_client().websocket_connect("/ws") as ws, pytest.raises(WebSocketDisconnect) as exc_info:
        ws.receive_json()

    assert exc_info.value.code == CLOSE_TIMEOUT_OR_LIMIT


def test_a_non_authenticate_first_frame_closes_4400() -> None:
    with ws_client().websocket_connect("/ws") as ws:
        ws.send_json({"v": 1, "type": "ping"})
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()

    assert exc_info.value.code == CLOSE_MALFORMED_FRAME


def test_malformed_json_closes_4400() -> None:
    with ws_client().websocket_connect("/ws") as ws:
        ws.send_text("not json at all")
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()

    assert exc_info.value.code == CLOSE_MALFORMED_FRAME


def test_the_wrong_protocol_version_closes_4400(monkeypatch: pytest.MonkeyPatch) -> None:
    with ws_client().websocket_connect("/ws") as ws:
        ws.send_json({"v": 2, "type": "authenticate", "ticket": "irrelevant"})
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()

    assert exc_info.value.code == CLOSE_MALFORMED_FRAME


# -- connection rate limiting -------------------------------------------------------------------


def test_an_ip_over_its_limit_closes_4408_before_authentication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def deny(_client_ip: str) -> bool:
        return False

    monkeypatch.setattr(websocket_module, "check_ip", deny)

    with ws_client().websocket_connect("/ws") as ws, pytest.raises(WebSocketDisconnect) as exc_info:
        ws.receive_json()

    assert exc_info.value.code == CLOSE_TIMEOUT_OR_LIMIT


def test_an_account_over_its_limit_closes_4408_after_a_valid_ticket(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def deny(_user_id: UUID) -> bool:
        return False

    monkeypatch.setattr(websocket_module, "check_account", deny)
    _stub_consume(monkeypatch, USER_ID)

    with ws_client().websocket_connect("/ws") as ws:
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()

    assert exc_info.value.code == CLOSE_TIMEOUT_OR_LIMIT


# -- post-authentication frames ----------------------------------------------------------------


def test_ping_is_answered_with_pong(monkeypatch: pytest.MonkeyPatch) -> None:
    with ws_client().websocket_connect("/ws") as ws:
        _stub_consume(monkeypatch, USER_ID)
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        ws.receive_json()

        ws.send_json({"v": 1, "type": "ping", "client_time": datetime.now(UTC).isoformat()})
        frame = ws.receive_json()

    assert frame["type"] == "pong"
    assert "server_time" in frame


def test_an_unknown_frame_type_closes_4400(monkeypatch: pytest.MonkeyPatch) -> None:
    with ws_client().websocket_connect("/ws") as ws:
        _stub_consume(monkeypatch, USER_ID)
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        ws.receive_json()

        ws.send_json({"v": 1, "type": "teleport"})
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()

    assert exc_info.value.code == CLOSE_MALFORMED_FRAME


def test_idle_after_authentication_closes_4408(monkeypatch: pytest.MonkeyPatch) -> None:
    with ws_client().websocket_connect("/ws") as ws:
        _stub_consume(monkeypatch, USER_ID)
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        ws.receive_json()

        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()

    assert exc_info.value.code == CLOSE_TIMEOUT_OR_LIMIT


# -- subscribe / unsubscribe --------------------------------------------------------------------


def test_a_granted_subscription_receives_the_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_authorize(
        monkeypatch,
        SubscriptionGranted(user=object(), audience="manager_floor", machine_id=None),
    )
    _stub_snapshot(monkeypatch, _snapshot_frame())

    with ws_client().websocket_connect("/ws") as ws:
        _stub_consume(monkeypatch, USER_ID)
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        ws.receive_json()

        ws.send_json({"v": 1, "type": "subscribe", "simulation_id": str(SIMULATION_ID)})
        frame = ws.receive_json()

    assert frame["type"] == "simulation.snapshot"
    assert frame["simulation_id"] == str(SIMULATION_ID)


def test_an_unavailable_snapshot_is_not_a_protocol_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Subscribed but nothing to show yet must not close the connection."""

    _stub_authorize(
        monkeypatch,
        SubscriptionGranted(user=object(), audience="manager_floor", machine_id=None),
    )
    _stub_snapshot(monkeypatch, SnapshotUnavailable())

    with ws_client().websocket_connect("/ws") as ws:
        _stub_consume(monkeypatch, USER_ID)
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        ws.receive_json()

        ws.send_json({"v": 1, "type": "subscribe", "simulation_id": str(SIMULATION_ID)})
        # No snapshot frame follows; a ping still works, proving the connection is alive.
        ws.send_json({"v": 1, "type": "ping"})
        frame = ws.receive_json()

    assert frame["type"] == "pong"


def test_a_refused_subscription_closes_4403(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_authorize(monkeypatch, SubscriptionRefused())

    with ws_client().websocket_connect("/ws") as ws:
        _stub_consume(monkeypatch, USER_ID)
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        ws.receive_json()

        ws.send_json({"v": 1, "type": "subscribe", "simulation_id": str(SIMULATION_ID)})
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()

    assert exc_info.value.code == CLOSE_FORBIDDEN


def test_subscribing_to_a_malformed_simulation_id_closes_4400(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with ws_client().websocket_connect("/ws") as ws:
        _stub_consume(monkeypatch, USER_ID)
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        ws.receive_json()

        ws.send_json({"v": 1, "type": "subscribe", "simulation_id": "not-a-uuid"})
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()

    assert exc_info.value.code == CLOSE_MALFORMED_FRAME


def test_exceeding_the_subscription_limit_closes_4408(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_authorize(
        monkeypatch,
        SubscriptionGranted(user=object(), audience="manager_floor", machine_id=None),
    )
    _stub_snapshot(monkeypatch, SnapshotUnavailable())

    with ws_client().websocket_connect("/ws") as ws:
        _stub_consume(monkeypatch, USER_ID)
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        ws.receive_json()

        for _ in range(MAX_SUBSCRIPTIONS_PER_CONNECTION):
            ws.send_json({"v": 1, "type": "subscribe", "simulation_id": str(uuid4())})
            ws.send_json({"v": 1, "type": "ping"})
            assert ws.receive_json()["type"] == "pong"

        ws.send_json({"v": 1, "type": "subscribe", "simulation_id": str(uuid4())})
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()

    assert exc_info.value.code == CLOSE_TIMEOUT_OR_LIMIT


def test_unsubscribe_stops_further_broadcasts(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_authorize(
        monkeypatch,
        SubscriptionGranted(user=object(), audience="manager_floor", machine_id=None),
    )
    _stub_snapshot(monkeypatch, SnapshotUnavailable())

    with ws_client().websocket_connect("/ws") as ws:
        _stub_consume(monkeypatch, USER_ID)
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        ws.receive_json()

        ws.send_json({"v": 1, "type": "subscribe", "simulation_id": str(SIMULATION_ID)})
        # `send_json` only enqueues the frame; a ping/pong round trip is what guarantees the
        # server has actually processed the subscribe before this checks the hub's state.
        ws.send_json({"v": 1, "type": "ping"})
        assert ws.receive_json()["type"] == "pong"
        assert hub.keys_for_simulation(SIMULATION_ID) != ()

        ws.send_json({"v": 1, "type": "unsubscribe", "simulation_id": str(SIMULATION_ID)})
        ws.send_json({"v": 1, "type": "ping"})
        assert ws.receive_json()["type"] == "pong"

    assert hub.keys_for_simulation(SIMULATION_ID) == ()


def test_disconnecting_cleans_up_the_hub(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_authorize(
        monkeypatch,
        SubscriptionGranted(user=object(), audience="manager_floor", machine_id=None),
    )
    _stub_snapshot(monkeypatch, SnapshotUnavailable())

    with ws_client().websocket_connect("/ws") as ws:
        _stub_consume(monkeypatch, USER_ID)
        ws.send_json({"v": 1, "type": "authenticate", "ticket": "good-ticket"})
        ws.receive_json()
        ws.send_json({"v": 1, "type": "subscribe", "simulation_id": str(SIMULATION_ID)})
        ws.send_json({"v": 1, "type": "ping"})
        assert ws.receive_json()["type"] == "pong"
        assert hub.keys_for_simulation(SIMULATION_ID) != ()

    assert hub.keys_for_simulation(SIMULATION_ID) == ()
