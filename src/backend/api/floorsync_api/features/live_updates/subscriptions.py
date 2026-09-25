"""Decide what a subscribing socket may see: whose simulation, and what scope of it.

Never trust anything a socket frame supplies about who it is beyond the ticket it redeemed --
that ticket names a user id, and this re-loads that user fresh (a ticket can be seconds or
minutes old, and an account can be deactivated in between). A manager sees the whole floor; an
operator sees exactly their assigned machine. Everything else is refused without saying why,
since a socket has not yet proven who it is asking on behalf of.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, assert_never
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.user import User
from floorsync_common.simulation import queries as simulation_queries
from floorsync_common.users.results import ActiveUserFound, ActiveUserNotFound
from floorsync_common.users.service import UserService

type AudienceScope = Literal["manager_floor", "operator_machine"]


@dataclass(frozen=True, slots=True)
class SubscriptionGranted:
    user: User
    audience: AudienceScope
    machine_id: UUID | None


@dataclass(frozen=True, slots=True)
class SubscriptionRefused:
    """Deliberately carries no reason. A refused socket gets close 4401/4403, never which check."""


type AuthorizeSubscriptionResult = SubscriptionGranted | SubscriptionRefused


class LiveSubscriptionAuthorizer:
    """Resolve a fresh user, a real simulation, and the scope between them. Stateless."""

    @staticmethod
    async def authorize(
        db: AsyncSession, *, user_id: UUID, simulation_id: UUID
    ) -> AuthorizeSubscriptionResult:
        """Grant `manager_floor` to any manager, `operator_machine` to an operator with a machine.

        Everything else -- a deactivated account, an unknown simulation, an operator with no
        assigned machine -- is refused identically.
        """
        user_result = await UserService.get_active_user(db, user_id=user_id)
        match user_result:
            case ActiveUserFound(user=user):
                pass
            case ActiveUserNotFound():
                return SubscriptionRefused()
            case _:
                assert_never(user_result)

        simulation = await simulation_queries.load_simulation(db, simulation_id)
        if simulation is None:
            return SubscriptionRefused()

        if user.role == "manager":
            return SubscriptionGranted(user=user, audience="manager_floor", machine_id=None)
        if user.role == "operator" and user.machine_id is not None:
            return SubscriptionGranted(
                user=user, audience="operator_machine", machine_id=user.machine_id
            )
        return SubscriptionRefused()


__all__ = [
    "AudienceScope",
    "LiveSubscriptionAuthorizer",
    "SubscriptionGranted",
    "SubscriptionRefused",
]
