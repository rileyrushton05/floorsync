"""Application operations for FloorSync users and their credentials."""

from floorsync_common.users.operators import OperatorService, operator_username_base
from floorsync_common.users.results import (
    ActiveUserFound,
    ActiveUserNotFound,
    AssignedMachineHasNoOperator,
    AssignedMachineNotFound,
    AuthenticationSucceeded,
    InvalidCredentials,
    OperatorAccount,
    OperatorNotFound,
    OperatorUpdated,
    UsernameAlreadyExists,
)
from floorsync_common.users.service import UserService

__all__ = [
    "ActiveUserFound",
    "ActiveUserNotFound",
    "AssignedMachineHasNoOperator",
    "AssignedMachineNotFound",
    "AuthenticationSucceeded",
    "InvalidCredentials",
    "OperatorAccount",
    "OperatorNotFound",
    "OperatorService",
    "OperatorUpdated",
    "UserService",
    "UsernameAlreadyExists",
    "operator_username_base",
]
