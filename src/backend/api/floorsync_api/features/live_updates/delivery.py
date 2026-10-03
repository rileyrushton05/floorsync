"""Send one outbox payload to Redis: the step the immediate publisher and the relay share.

It does no database work. Both callers settle the row differently (the publisher marks it in its
own short transaction; the relay settles inside the transaction that holds the row's lock), so
each keeps owning that and only this step is shared.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from redis.exceptions import RedisError

from floorsync_api.features.live_updates.redis_client import (
    SIMULATION_CHANGED_CHANNEL,
    get_redis_client,
)
from floorsync_common.live_updates.contracts import SimulationChangedEnvelope, UnsupportedEnvelope


@dataclass(frozen=True, slots=True)
class Delivered:
    """Redis accepted the payload."""


@dataclass(frozen=True, slots=True)
class PayloadUnreadable:
    """No subscriber would accept this payload, so it was not sent. Retrying cannot fix it."""

    event_id: str | None


@dataclass(frozen=True, slots=True)
class RedisRefused:
    """Redis was unreachable, hung, or rejected the publish."""

    error: RedisError


type DeliveryResult = Delivered | PayloadUnreadable | RedisRefused


async def deliver(payload: Any) -> DeliveryResult:
    """Validate `payload` as an envelope, then publish it verbatim.

    Validating first reports a broken row at the source, with its event id, instead of publishing
    it for every subscriber to drop.
    """
    try:
        SimulationChangedEnvelope.from_payload(payload)
    except UnsupportedEnvelope:
        event_id = payload.get("event_id") if isinstance(payload, dict) else None
        return PayloadUnreadable(event_id=str(event_id) if event_id is not None else None)

    try:
        await get_redis_client().publish(SIMULATION_CHANGED_CHANNEL, json.dumps(payload))
    except RedisError as error:
        return RedisRefused(error=error)
    return Delivered()


__all__ = ["Delivered", "DeliveryResult", "PayloadUnreadable", "RedisRefused", "deliver"]
