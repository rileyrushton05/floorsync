from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import StringConstraints, model_validator

from floorsync_api.schemas import RequestSchema, ResponseSchema
from floorsync_common.users import OperatorAccount

type DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
type Username = Annotated[
    str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=1)
]
# Passwords are taken exactly as typed: trimming one would silently change it.
type Password = Annotated[str, StringConstraints(min_length=1)]


class OperatorUpdateRequest(RequestSchema):
    """A partial update to an operator login. Every field is optional and none may be null.

    `password` replaces the current one outright; the manager does not need to know the old one.
    There is no `machine_id`: an operator stays on the machine it was created for, and sending one
    is rejected like any other unknown field.
    """

    name: DisplayName | None = None
    username: Username | None = None
    password: Password | None = None
    active: bool | None = None

    @model_validator(mode="after")
    def reject_null(self) -> "OperatorUpdateRequest":
        nulled = sorted(field for field in self.model_fields_set if getattr(self, field) is None)
        if nulled:
            raise ValueError(f"{', '.join(nulled)} cannot be null")
        return self


class OperatorResponse(ResponseSchema):
    """An operator login as a manager sees it. Never includes the password or its hash."""

    id: UUID
    name: str
    username: str
    active: bool
    machine_id: UUID
    machine_name: str
    last_authenticated_at: datetime | None
    created_at: datetime

    @classmethod
    def from_account(cls, account: OperatorAccount) -> "OperatorResponse":
        user, credential = account.user, account.credential
        assert user.machine_id is not None  # guaranteed for operators by a check constraint
        return cls(
            id=user.id,
            name=user.name,
            username=credential.username,
            active=credential.active,
            machine_id=user.machine_id,
            machine_name=account.machine_name,
            last_authenticated_at=credential.last_authenticated_at,
            created_at=user.created_at,
        )
