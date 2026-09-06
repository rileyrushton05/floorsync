from dataclasses import dataclass
from uuid import UUID

from floorsync_common.database.models.user import User
from floorsync_common.outcomes import ExpectedOutcome


@dataclass(frozen=True, slots=True)
class AuthenticationSucceeded:
    user: User


@dataclass(frozen=True, slots=True)
class InvalidCredentials(ExpectedOutcome):
    username: str


type AuthenticateUserResult = AuthenticationSucceeded | InvalidCredentials


@dataclass(frozen=True, slots=True)
class ActiveUserFound:
    user: User


@dataclass(frozen=True, slots=True)
class ActiveUserNotFound(ExpectedOutcome):
    user_id: UUID


type GetActiveUserResult = ActiveUserFound | ActiveUserNotFound
