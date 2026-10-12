"""Machine, category and capability persistence with caller-owned transactions.

Nothing here commits or rolls back: the route owns the transaction boundary, per
docs/backend-conventions.md. Machine name uniqueness is checked here for a readable outcome and
enforced again by the database, which is what actually holds under concurrent writes; category names
are left to the database alone (see `CategoryService`).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Select, func, select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.category import Category
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.machines.results import (
    CapabilitiesListed,
    CapabilityNotFound,
    CapabilityRemoved,
    CapabilitySet,
    CategoryCreated,
    CategoryDeleted,
    CategoryInUse,
    CategoryNameAlreadyExists,
    CategoryNotFound,
    CategoryRenamed,
    CreateCategoryResult,
    CreateMachineResult,
    DeleteCategoryResult,
    DeleteMachineResult,
    GetMachineResult,
    ListCapabilitiesResult,
    MachineCreated,
    MachineDeleted,
    MachineFound,
    MachineHasOperations,
    MachineNameAlreadyExists,
    MachineNotFound,
    MachineUpdated,
    RemoveCapabilityResult,
    RenameCategoryResult,
    SetCapabilityResult,
    UpdateMachineResult,
)
from floorsync_common.operations.results import OperationNotFound
from floorsync_common.pagination import decode_cursor, encode_cursor
from floorsync_common.partial import UNSET, Unset, is_set
from floorsync_common.users.operators import OperatorService
from floorsync_common.users.service import UserService


@dataclass(frozen=True, slots=True)
class MachinePage:
    """One page of machines, with the cursor that reads the next one."""

    machines: tuple[Machine, ...]
    next_cursor: str | None


class MachineService:
    """Stateless machine and capability operations."""

    @staticmethod
    async def create_machine(
        db: AsyncSession,
        *,
        name: str,
        category_id: UUID | None = None,
        salary: Decimal | None = None,
        active: bool = True,
        operator_password: str,
    ) -> CreateMachineResult:
        """Add a machine together with its operator login, rejecting a duplicate name or an unknown
        category.

        Every machine has its own login, so the two are created in the same transaction: the
        operator starts with `operator_password`, under a username derived from the machine's name.
        """

        normalized_name = name.strip()
        if await MachineService._machine_name_taken(db, normalized_name):
            return MachineNameAlreadyExists(name=normalized_name)
        if category_id is not None and not await MachineService._category_exists(db, category_id):
            return CategoryNotFound(category_id=category_id)

        machine = Machine(
            name=normalized_name,
            category_id=category_id,
            salary=salary,
            active=active,
        )
        db.add(machine)
        await db.flush()
        await OperatorService.create_for_machine(
            db, machine, password_hash=UserService.hash_password(operator_password)
        )
        return MachineCreated(machine=machine)

    @staticmethod
    async def get_machine(db: AsyncSession, machine_id: UUID) -> GetMachineResult:
        """Read one machine together with the capabilities declared for it."""

        machine = await db.get(Machine, machine_id)
        if machine is None:
            return MachineNotFound(machine_id=machine_id)

        capabilities = (
            await db.scalars(
                select(Compatibility)
                .where(Compatibility.machine_id == machine_id)
                .order_by(Compatibility.operation_id)
            )
        ).all()
        return MachineFound(machine=machine, capabilities=tuple(capabilities))

    @staticmethod
    async def list_machines(
        db: AsyncSession,
        *,
        limit: int = 50,
        cursor: str | None = None,
    ) -> MachinePage:
        """Read one page of machines ordered by name, with id as the tie-breaker.

        One row beyond the requested limit is fetched to decide whether a next page exists, rather
        than issuing a second count query that could disagree with this one under concurrent writes.
        """

        statement: Select[tuple[Machine]] = select(Machine).order_by(Machine.name, Machine.id)
        position = decode_cursor(cursor)
        if position is not None:
            statement = statement.where(tuple_(Machine.name, Machine.id) > position)

        rows = (await db.scalars(statement.limit(limit + 1))).all()
        page = tuple(rows[:limit])
        next_cursor = (
            encode_cursor(page[-1].name, page[-1].id) if len(rows) > limit and page else None
        )
        return MachinePage(machines=page, next_cursor=next_cursor)

    @staticmethod
    async def update_machine(
        db: AsyncSession,
        machine_id: UUID,
        *,
        name: str | Unset = UNSET,
        category_id: UUID | Unset | None = UNSET,
        salary: Decimal | Unset | None = UNSET,
        active: bool | Unset = UNSET,
    ) -> UpdateMachineResult:
        """Apply a partial update, leaving omitted fields untouched."""

        machine = await db.get(Machine, machine_id)
        if machine is None:
            return MachineNotFound(machine_id=machine_id)

        renamed_from: str | None = None
        if is_set(name):
            normalized_name = name.strip()
            if normalized_name != machine.name and await MachineService._machine_name_taken(
                db, normalized_name
            ):
                return MachineNameAlreadyExists(name=normalized_name)
            if normalized_name != machine.name:
                renamed_from = machine.name
            machine.name = normalized_name

        if is_set(category_id):
            if category_id is not None and not await MachineService._category_exists(
                db, category_id
            ):
                return CategoryNotFound(category_id=category_id)
            machine.category_id = category_id

        if is_set(salary):
            machine.salary = salary

        if is_set(active):
            machine.active = active

        if renamed_from is not None:
            await OperatorService.follow_machine_rename(
                db, machine_id, previous_name=renamed_from, new_name=machine.name
            )

        await db.flush()
        # `salary` is NUMERIC(10, 2): PostgreSQL rounds what it stores (12.555 becomes 12.56).
        # Reloading returns the stored value rather than echoing the unrounded request.
        await db.refresh(machine)
        return MachineUpdated(machine=machine)

    @staticmethod
    async def remove_machine(db: AsyncSession, machine_id: UUID) -> DeleteMachineResult:
        """Remove a machine that no operation is assigned to.

        Compatibilities and unavailability windows cascade with the machine, and its operator login
        is deleted with it, since an operator cannot exist without a machine. Operations do not: the
        route says which machines can run an operation, so a machine still named there is load
        bearing and the delete is refused with a reason instead of an integrity error.
        """

        machine = await db.get(Machine, machine_id)
        if machine is None:
            return MachineNotFound(machine_id=machine_id)

        assigned_operations = await db.scalar(
            select(func.count())
            .select_from(Compatibility)
            .where(Compatibility.machine_id == machine_id)
        )
        if assigned_operations:
            return MachineHasOperations(machine_id=machine_id, operation_count=assigned_operations)

        await OperatorService.remove_for_machine(db, machine_id)
        await db.delete(machine)
        await db.flush()
        return MachineDeleted(machine_id=machine_id)

    @staticmethod
    async def list_capabilities(db: AsyncSession, machine_id: UUID) -> ListCapabilitiesResult:
        """List what a machine can run, separating "no such machine" from "nothing declared"."""

        if await db.get(Machine, machine_id) is None:
            return MachineNotFound(machine_id=machine_id)

        capabilities = (
            await db.scalars(
                select(Compatibility)
                .where(Compatibility.machine_id == machine_id)
                .order_by(Compatibility.operation_id)
            )
        ).all()
        return CapabilitiesListed(capabilities=tuple(capabilities))

    @staticmethod
    async def set_capability(
        db: AsyncSession,
        machine_id: UUID,
        operation_id: UUID,
        *,
        duration: int,
        energy: Decimal | None = None,
    ) -> SetCapabilityResult:
        """Declare, or re-state, that a machine can run an operation and what it costs.

        Idempotent by (machine, operation), matching the unique constraint on those two columns:
        re-sending a pairing updates its cost rather than failing on the second attempt.
        """

        if await db.get(Machine, machine_id) is None:
            return MachineNotFound(machine_id=machine_id)
        if await db.get(Operation, operation_id) is None:
            return OperationNotFound(operation_id=operation_id)

        capability = await db.scalar(
            select(Compatibility).where(
                Compatibility.machine_id == machine_id,
                Compatibility.operation_id == operation_id,
            )
        )
        created = capability is None
        if capability is None:
            capability = Compatibility(
                machine_id=machine_id,
                operation_id=operation_id,
                duration=duration,
                energy=energy,
            )
            db.add(capability)
        else:
            capability.duration = duration
            capability.energy = energy

        await db.flush()
        # Same reason as update_machine: `energy` is NUMERIC(10, 2), so return what was stored.
        await db.refresh(capability)
        return CapabilitySet(capability=capability, created=created)

    @staticmethod
    async def remove_capability(
        db: AsyncSession,
        machine_id: UUID,
        operation_id: UUID,
    ) -> RemoveCapabilityResult:
        """Withdraw a machine's ability to run an operation."""

        capability = await db.scalar(
            select(Compatibility).where(
                Compatibility.machine_id == machine_id,
                Compatibility.operation_id == operation_id,
            )
        )
        if capability is None:
            return CapabilityNotFound(machine_id=machine_id, operation_id=operation_id)

        await db.delete(capability)
        await db.flush()
        return CapabilityRemoved(machine_id=machine_id, operation_id=operation_id)

    @staticmethod
    async def _machine_name_taken(db: AsyncSession, name: str) -> bool:
        return await db.scalar(select(Machine.id).where(Machine.name == name)) is not None

    @staticmethod
    async def _category_exists(db: AsyncSession, category_id: UUID) -> bool:
        """Whether the category exists, kept from being deleted until the transaction ends.

        Key-share is the lock the machine's foreign key takes anyway, taken here at the check: a
        concurrent delete is waited for and seen, instead of passing this check and then failing
        the foreign key. Renames are not blocked.
        """

        category = await db.scalar(
            select(Category.id)
            .where(Category.id == category_id)
            .with_for_update(read=True, key_share=True)
        )
        return category is not None


class CategoryService:
    """Stateless category operations.

    Categories group machines and carry nothing else, so the collection stays small and bounded and
    is returned whole rather than paged.

    Names are unique ignoring case, and only the `uq_categories_lower_name` index decides that: a
    name is written inside a savepoint and a clash on that index becomes the expected outcome. A
    pre-check could not see a name another transaction has written but not committed yet; the index
    makes the second writer wait for the first and then refuses it.
    """

    @staticmethod
    async def create_category(db: AsyncSession, *, name: str) -> CreateCategoryResult:
        """Add a category, rejecting a name already used in any capitalisation."""

        normalized_name = name.strip()
        category = Category(name=normalized_name)
        try:
            async with db.begin_nested():
                db.add(category)
                await db.flush()
        except IntegrityError as error:
            if not _is_category_name_clash(error):
                raise
            return CategoryNameAlreadyExists(
                name=await CategoryService._existing_name(db, normalized_name)
            )
        return CategoryCreated(category=category)

    @staticmethod
    async def rename_category(
        db: AsyncSession, category_id: UUID, *, name: str
    ) -> RenameCategoryResult:
        """Rename a category, rejecting a name another category uses in any capitalisation.

        Changing only the capitalisation of its own name is allowed. The row is locked first, so
        a delete that commits meanwhile makes this not found rather than an update of nothing.
        `FOR NO KEY UPDATE` is the lock the update takes anyway: it waits for a delete but not
        for a machine being assigned the category.
        """

        category = await db.scalar(
            select(Category).where(Category.id == category_id).with_for_update(key_share=True)
        )
        if category is None:
            return CategoryNotFound(category_id=category_id)

        normalized_name = name.strip()
        try:
            async with db.begin_nested():
                category.name = normalized_name
                await db.flush()
        except IntegrityError as error:
            if not _is_category_name_clash(error):
                raise
            return CategoryNameAlreadyExists(
                name=await CategoryService._existing_name(db, normalized_name)
            )
        return CategoryRenamed(category=category)

    @staticmethod
    async def remove_category(db: AsyncSession, category_id: UUID) -> DeleteCategoryResult:
        """Remove a category no machine belongs to.

        A category in use is refused rather than detached from its machines. The row is locked
        before its machines are counted, and assigning a category locks it in key-share mode
        (`MachineService._category_exists`), so a machine being added to it either finishes first
        and is counted, or waits and then finds the category gone.
        """

        category = await db.scalar(
            select(Category).where(Category.id == category_id).with_for_update()
        )
        if category is None:
            return CategoryNotFound(category_id=category_id)

        machine_count = await db.scalar(
            select(func.count()).select_from(Machine).where(Machine.category_id == category_id)
        )
        if machine_count:
            return CategoryInUse(category_id=category_id, machine_count=machine_count)

        await db.delete(category)
        await db.flush()
        return CategoryDeleted(category_id=category_id)

    @staticmethod
    async def list_categories(db: AsyncSession) -> tuple[Category, ...]:
        """List every category by name."""

        categories = (await db.scalars(select(Category).order_by(Category.name))).all()
        return tuple(categories)

    @staticmethod
    async def _existing_name(db: AsyncSession, name: str) -> str:
        """How the floor spells the category `name` clashed with, for the refusal to quote."""

        existing = await db.scalar(
            select(Category.name).where(func.lower(Category.name) == func.lower(name))
        )
        # Deleted again since the clash: quote the request.
        return existing or name


def _is_category_name_clash(error: IntegrityError) -> bool:
    """Whether the write broke the category name index, not some other constraint.

    The driver's own error, the one wrapped by SQLAlchemy's, names the index it violated.
    """

    driver_error = error.orig.__cause__ if error.orig is not None else None
    return getattr(driver_error, "constraint_name", None) == "uq_categories_lower_name"
