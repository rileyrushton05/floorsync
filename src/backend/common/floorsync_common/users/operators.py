"""Operator logins, which exist one per machine and follow it through its lifecycle.

Every machine gets an operator login when it is created, with the configured default password and a
username derived from the machine's name. Renaming the machine re-derives the username; removing the
machine removes the login, because an operator without a machine is not a valid account. Managers
adjust the rest -- display name, username, password, whether it may sign in, and which of two
operators runs which machine -- through `update_operator`.

Nothing here commits or rolls back: the caller owns the transaction, per
docs/backend-conventions.md.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import case, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.user import User
from floorsync_common.database.models.user_credential import UserCredential
from floorsync_common.partial import UNSET, Unset, is_set
from floorsync_common.users.results import (
    AssignedMachineHasNoOperator,
    AssignedMachineNotFound,
    OperatorAccount,
    OperatorNotFound,
    OperatorUpdated,
    UpdateOperatorResult,
    UsernameAlreadyExists,
)
from floorsync_common.users.service import UserService

_NOT_SLUG = re.compile(r"[^a-z0-9]+")


def operator_username_base(machine_name: str) -> str:
    """The username a machine's operator should have: 'abz5/M0' becomes 'abz5-m0'.

    Runs of anything but lowercase letters and digits collapse into one hyphen, so the result is
    already lowercase, as `username_is_lowercase` requires, and safe inside a LIKE pattern.
    """

    return _NOT_SLUG.sub("-", machine_name.lower()).strip("-") or "operator"


class OperatorService:
    """Stateless operator-login operations."""

    @staticmethod
    async def create_for_machine(
        db: AsyncSession,
        machine: Machine,
        *,
        password_hash: str,
    ) -> OperatorAccount:
        """Give a newly created machine its operator login.

        Takes a hash rather than a password so a caller creating many at once, like seeding, can
        pay for Argon2 once instead of per machine.
        """

        username = await _free_username(db, operator_username_base(machine.name))
        user = User(name=machine.name, role="operator", machine_id=machine.id)
        db.add(user)
        await db.flush()
        credential = UserCredential(user_id=user.id, username=username, password_hash=password_hash)
        db.add(credential)
        await db.flush()
        return OperatorAccount(user=user, credential=credential, machine_name=machine.name)

    @staticmethod
    async def create_for_machines(
        db: AsyncSession,
        machines: Sequence[tuple[UUID, str]],
        *,
        password_hash: str,
    ) -> int:
        """Give each of a batch of new machines, as (id, name), its operator login."""

        taken = set((await db.scalars(select(UserCredential.username))).all())
        for machine_id, machine_name in machines:
            username = _first_free(operator_username_base(machine_name), taken)
            taken.add(username)
            user = User(name=machine_name, role="operator", machine_id=machine_id)
            db.add(user)
            await db.flush()
            db.add(UserCredential(user_id=user.id, username=username, password_hash=password_hash))
        await db.flush()
        return len(machines)

    @staticmethod
    async def follow_machine_rename(
        db: AsyncSession,
        machine_id: UUID,
        *,
        previous_name: str,
        new_name: str,
    ) -> None:
        """Re-derive the operator's username from the machine's new name.

        The display name follows too, but only while it is still the machine's old name: one a
        manager has deliberately changed is left as they set it.
        """

        row = (
            (
                await db.execute(
                    select(User, UserCredential)
                    .join(UserCredential, UserCredential.user_id == User.id)
                    .where(User.machine_id == machine_id)
                )
            )
            .tuples()
            .one_or_none()
        )
        if row is None:
            return

        user, credential = row
        credential.username = await _free_username(
            db, operator_username_base(new_name), exclude_user_id=user.id
        )
        if user.name == previous_name:
            user.name = new_name
        await db.flush()

    @staticmethod
    async def remove_for_machine(db: AsyncSession, machine_id: UUID) -> None:
        """Delete the operator login bound to a machine that is about to be deleted."""

        user_ids = list(
            (await db.scalars(select(User.id).where(User.machine_id == machine_id))).all()
        )
        if not user_ids:
            return
        await db.execute(delete(UserCredential).where(UserCredential.user_id.in_(user_ids)))
        await db.execute(delete(User).where(User.id.in_(user_ids)))

    @staticmethod
    async def list_operators(db: AsyncSession) -> tuple[OperatorAccount, ...]:
        """Every operator login, ordered by the machine it runs."""

        rows = (
            await db.execute(
                select(User, UserCredential, Machine.name)
                .join(UserCredential, UserCredential.user_id == User.id)
                .join(Machine, Machine.id == User.machine_id)
                .where(User.role == "operator")
                .order_by(Machine.name, User.id)
            )
        ).tuples()
        return tuple(
            OperatorAccount(user=user, credential=credential, machine_name=machine_name)
            for user, credential, machine_name in rows
        )

    @staticmethod
    async def update_operator(
        db: AsyncSession,
        user_id: UUID,
        *,
        name: str | Unset = UNSET,
        username: str | Unset = UNSET,
        password: str | Unset = UNSET,
        active: bool | Unset = UNSET,
        machine_id: UUID | Unset = UNSET,
    ) -> UpdateOperatorResult:
        """Apply a partial update to an operator login, leaving omitted fields untouched.

        Every field is validated before anything is written, so a rejected request changes nothing.
        A new machine swaps with the operator already running it.
        """

        row = (
            (
                await db.execute(
                    select(User, UserCredential)
                    .join(UserCredential, UserCredential.user_id == User.id)
                    .where(User.id == user_id, User.role == "operator")
                )
            )
            .tuples()
            .one_or_none()
        )
        if row is None:
            return OperatorNotFound(user_id=user_id)
        user, credential = row

        normalized_username: str | None = None
        if is_set(username):
            normalized_username = username.strip().lower()
            if normalized_username != credential.username and await _username_taken(
                db, normalized_username
            ):
                return UsernameAlreadyExists(username=normalized_username)

        swap_with: User | None = None
        if is_set(machine_id) and machine_id != user.machine_id:
            if await db.get(Machine, machine_id) is None:
                return AssignedMachineNotFound(machine_id=machine_id)
            swap_with = await db.scalar(select(User).where(User.machine_id == machine_id))
            if swap_with is None:
                return AssignedMachineHasNoOperator(machine_id=machine_id)

        if swap_with is not None and is_set(machine_id):
            # One statement for both rows: the unique constraint is deferrable so it can pass
            # through the moment both hold the same machine, and the role check forbids parking
            # either one on NULL instead.
            await db.execute(
                update(User)
                .where(User.id.in_((user.id, swap_with.id)))
                .values(machine_id=case((User.id == user.id, machine_id), else_=user.machine_id))
                .execution_options(synchronize_session=False)
            )

        if is_set(name):
            user.name = name.strip()
        if normalized_username is not None:
            credential.username = normalized_username
        if is_set(password):
            credential.password_hash = UserService.hash_password(password)
        if is_set(active):
            credential.active = active

        await db.flush()
        # The swap wrote `machine_id` behind the ORM's back, so reload the row to return the
        # machine the operator actually holds now.
        await db.refresh(user)
        machine_name = await db.scalar(select(Machine.name).where(Machine.id == user.machine_id))
        return OperatorUpdated(
            account=OperatorAccount(
                user=user, credential=credential, machine_name=machine_name or ""
            )
        )


async def _username_taken(db: AsyncSession, username: str) -> bool:
    found = await db.scalar(select(UserCredential.id).where(UserCredential.username == username))
    return found is not None


async def _free_username(
    db: AsyncSession, base: str, *, exclude_user_id: UUID | None = None
) -> str:
    """`base`, or `base-2`, `base-3`... whichever no other login already uses."""

    statement = select(UserCredential.username).where(
        or_(UserCredential.username == base, UserCredential.username.like(f"{base}-%"))
    )
    if exclude_user_id is not None:
        statement = statement.where(UserCredential.user_id != exclude_user_id)
    return _first_free(base, set((await db.scalars(statement)).all()))


def _first_free(base: str, taken: set[str]) -> str:
    if base not in taken:
        return base
    suffix = 2
    while f"{base}-{suffix}" in taken:
        suffix += 1
    return f"{base}-{suffix}"
