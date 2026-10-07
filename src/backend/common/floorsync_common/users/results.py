from dataclasses import dataclass
from uuid import UUID

from floorsync_common.database.models.user import User
from floorsync_common.database.models.user_credential import UserCredential
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


@dataclass(frozen=True, slots=True)
class OperatorAccount:
    """An operator login as a manager sees it: the user, its credential and its machine's name."""

    user: User
    credential: UserCredential
    machine_name: str


@dataclass(frozen=True, slots=True)
class OperatorUpdated:
    account: OperatorAccount


@dataclass(frozen=True, slots=True)
class OperatorNotFound(ExpectedOutcome):
    user_id: UUID


@dataclass(frozen=True, slots=True)
class UsernameAlreadyExists(ExpectedOutcome):
    """`user_credentials.username` is unique across managers and operators alike."""

    username: str


@dataclass(frozen=True, slots=True)
class AssignedMachineNotFound(ExpectedOutcome):
    machine_id: UUID


@dataclass(frozen=True, slots=True)
class AssignedMachineHasNoOperator(ExpectedOutcome):
    """Reassigning swaps two operators' machines, so the target must already have an operator.

    Moving an operator onto a free machine would leave its old machine with no login, and nothing
    else creates one for an existing machine.
    """

    machine_id: UUID


type UpdateOperatorResult = (
    OperatorUpdated
    | OperatorNotFound
    | UsernameAlreadyExists
    | AssignedMachineNotFound
    | AssignedMachineHasNoOperator
)
