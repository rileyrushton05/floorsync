"""Short-lived, single-use tickets that authenticate a WebSocket without a bearer JWT in the URL.

A ticket is an opaque random value handed to an already-authenticated HTTP caller; only its
SHA-256 hash is ever stored in Redis, so a Redis inspection or log line never exposes something
usable to authenticate with. `GETDEL` makes consuming it single-use in one atomic round trip: a
connect attempt that replays an observed ticket always fails, even for the very next attempt.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from typing import Final
from uuid import UUID

from floorsync_api.features.live_updates.redis_client import get_redis_client

TICKET_TTL_SECONDS: Final = 60
_KEY_PREFIX: Final = "floorsync:live-ticket:"


@dataclass(frozen=True, slots=True)
class IssuedTicket:
    ticket: str
    expires_at: datetime


class LiveUpdateTicketService:
    """Issue and consume one-time WebSocket tickets. Stateless; Redis holds the record."""

    @staticmethod
    async def issue(*, user_id: UUID) -> IssuedTicket:
        """Create one ticket bound to `user_id`, valid for `TICKET_TTL_SECONDS`."""
        ticket = token_urlsafe(32)
        issued_at = datetime.now(UTC)
        record = {"user_id": str(user_id), "issued_at": issued_at.isoformat()}
        await get_redis_client().set(_key(ticket), json.dumps(record), ex=TICKET_TTL_SECONDS)
        return IssuedTicket(
            ticket=ticket, expires_at=issued_at + timedelta(seconds=TICKET_TTL_SECONDS)
        )

    @staticmethod
    async def consume(ticket: str) -> UUID | None:
        """Redeem `ticket` exactly once, returning the user it was issued to, or `None`.

        A missing, expired, malformed, or already-consumed ticket all look identical here: the
        socket authenticator maps every one of them to close code 4401 without distinguishing why
        (never reveal to an unauthenticated caller which case it hit).
        """
        raw = await get_redis_client().getdel(_key(ticket))
        if raw is None:
            return None
        try:
            record = json.loads(raw)
            return UUID(record["user_id"])
        except (json.JSONDecodeError, KeyError, ValueError, TypeError):
            return None


def _key(ticket: str) -> str:
    """Hash the lookup key so the value stored in Redis is never itself a usable ticket."""
    digest = hashlib.sha256(ticket.encode()).hexdigest()
    return f"{_KEY_PREFIX}{digest}"


__all__ = ["TICKET_TTL_SECONDS", "IssuedTicket", "LiveUpdateTicketService"]
