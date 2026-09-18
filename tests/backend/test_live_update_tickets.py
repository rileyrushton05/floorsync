"""One-time WebSocket tickets (#148): the Redis-backed service and the route that issues one."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.features.live_updates import tickets as tickets_module
from floorsync_api.features.live_updates.router import router as live_updates_router
from floorsync_api.features.live_updates.tickets import TICKET_TTL_SECONDS, LiveUpdateTicketService

USER_ID = UUID("11111111-1111-4111-8111-111111111111")


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


class FakeRedis:
    """A single-key-space stand-in: enough to exercise storage, TTL args and single-use."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.set_calls: list[tuple[str, str, int | None]] = []

    async def set(self, key: str, value: str, *, ex: int | None = None) -> None:
        self.store[key] = value
        self.set_calls.append((key, value, ex))

    async def getdel(self, key: str) -> str | None:
        return self.store.pop(key, None)


# -- service ----------------------------------------------------------------------------------


def test_issue_stores_a_hashed_key_never_the_raw_ticket(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    monkeypatch.setattr(tickets_module, "get_redis_client", lambda: redis)

    issued = run(LiveUpdateTicketService.issue(user_id=USER_ID))

    (key, _value, _ex) = redis.set_calls[0]
    assert issued.ticket not in redis.store
    assert issued.ticket not in key
    assert key.startswith("floorsync:live-ticket:")


def test_issue_sets_the_ttl_and_a_matching_expiry(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    monkeypatch.setattr(tickets_module, "get_redis_client", lambda: redis)

    before = datetime.now(UTC)
    issued = run(LiveUpdateTicketService.issue(user_id=USER_ID))
    after = datetime.now(UTC)

    (_key, _value, ex) = redis.set_calls[0]
    assert ex == TICKET_TTL_SECONDS
    assert before + timedelta(seconds=TICKET_TTL_SECONDS) <= issued.expires_at
    assert issued.expires_at <= after + timedelta(seconds=TICKET_TTL_SECONDS)


def test_issue_records_the_user_id_and_issued_at(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    monkeypatch.setattr(tickets_module, "get_redis_client", lambda: redis)

    run(LiveUpdateTicketService.issue(user_id=USER_ID))

    (_key, value, _ex) = redis.set_calls[0]
    record = json.loads(value)
    assert record["user_id"] == str(USER_ID)
    assert "issued_at" in record


def test_a_ticket_redeems_to_the_user_it_was_issued_for(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    monkeypatch.setattr(tickets_module, "get_redis_client", lambda: redis)
    issued = run(LiveUpdateTicketService.issue(user_id=USER_ID))

    redeemed = run(LiveUpdateTicketService.consume(issued.ticket))

    assert redeemed == USER_ID


def test_a_ticket_cannot_be_redeemed_twice(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    monkeypatch.setattr(tickets_module, "get_redis_client", lambda: redis)
    issued = run(LiveUpdateTicketService.issue(user_id=USER_ID))

    first = run(LiveUpdateTicketService.consume(issued.ticket))
    second = run(LiveUpdateTicketService.consume(issued.ticket))

    assert first == USER_ID
    assert second is None


def test_an_unknown_ticket_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    monkeypatch.setattr(tickets_module, "get_redis_client", lambda: redis)

    redeemed = run(LiveUpdateTicketService.consume("never-issued"))

    assert redeemed is None


def test_a_malformed_stored_record_is_refused_not_crashed_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ticket is trusted input from Redis, not the caller -- still validated on the way out."""

    redis = FakeRedis()
    monkeypatch.setattr(tickets_module, "get_redis_client", lambda: redis)
    key = tickets_module._key("some-ticket")
    redis.store[key] = json.dumps({"user_id": "not-a-uuid"})

    redeemed = run(LiveUpdateTicketService.consume("some-ticket"))

    assert redeemed is None


# -- route --------------------------------------------------------------------------------------


def ticket_client() -> TestClient:
    app = FastAPI()
    app.include_router(live_updates_router, prefix="/api/v1")

    class FakeUser:
        def __init__(self) -> None:
            self.id = USER_ID
            self.role = "operator"
            self.machine_id = None

    app.dependency_overrides[get_current_user] = lambda: FakeUser()
    return TestClient(app)


def test_create_ticket_returns_201_never_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_issue(*, user_id: UUID) -> Any:
        from floorsync_api.features.live_updates.tickets import IssuedTicket

        assert user_id == USER_ID
        return IssuedTicket(ticket="opaque-value", expires_at=datetime.now(UTC))

    monkeypatch.setattr(LiveUpdateTicketService, "issue", staticmethod(fake_issue))

    response = ticket_client().post("/api/v1/live-updates/tickets")

    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["ticket"] == "opaque-value"


def test_create_ticket_is_open_to_any_signed_in_role(monkeypatch: pytest.MonkeyPatch) -> None:
    """An operator watching their own machine needs a ticket too, not just a manager."""

    redis = FakeRedis()
    monkeypatch.setattr(tickets_module, "get_redis_client", lambda: redis)

    response = ticket_client().post("/api/v1/live-updates/tickets")

    assert response.status_code == 201
