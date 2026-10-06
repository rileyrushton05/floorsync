"""Machine, category and capability persistence with caller-owned transactions.

Nothing here commits or rolls back: the route owns the transaction boundary, per
docs/backend-conventions.md. Uniqueness is checked here for a readable outcome and enforced again by
the database, which is what actually holds under concurrent writes.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Select, func, select, tuple_
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
    CategoryNameAlreadyExists,
    CategoryNotFound,
    CreateCategoryResult,
    CreateMachineResult,
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
    SetCapabilityResult,
    UpdateMachineResult,
)
from floorsync_common.operations.results import OperationNotFound
from floorsync_common.pagination import decode_cursor, encode_cursor
from floorsync_common.partial import UNSET, Unset, is_set


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
    ) -> CreateMachineResult:
        """Add a machine, rejecting a duplicate name or an unknown category."""

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

        if is_set(name):
            normalized_name = name.strip()
            if normalized_name != machine.name and await MachineService._machine_name_taken(
                db, normalized_name
            ):
                return MachineNameAlreadyExists(name=normalized_name)
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

        await db.flush()
        # `salary` is NUMERIC(10, 2): PostgreSQL rounds what it stores (12.555 becomes 12.56).
        # Reloading returns the stored value rather than echoing the unrounded request.
        await db.refresh(machine)
        return MachineUpdated(machine=machine)

    @staticmethod
    async def remove_machine(db: AsyncSession, machine_id: UUID) -> DeleteMachineResult:
        """Remove a machine that no operation is assigned to.

        Compatibilities and unavailability windows cascade with the machine, and no operator login
        may still point at it by the time it has no capabilities left. Operations do not: the
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
        return (await db.scalar(select(Category.id).where(Category.id == category_id))) is not None


class CategoryService:
    """Stateless category operations.

    Categories group machines and carry nothing else, so the collection stays small and bounded and
    is returned whole rather than paged.
    """

    @staticmethod
    async def create_category(db: AsyncSession, *, name: str) -> CreateCategoryResult:
        """Add a category, rejecting a duplicate name."""

        normalized_name = name.strip()
        existing = await db.scalar(select(Category.id).where(Category.name == normalized_name))
        if existing is not None:
            return CategoryNameAlreadyExists(name=normalized_name)

        category = Category(name=normalized_name)
        db.add(category)
        await db.flush()
        return CategoryCreated(category=category)

    @staticmethod
    async def list_categories(db: AsyncSession) -> tuple[Category, ...]:
        """List every category by name."""

        categories = (await db.scalars(select(Category).order_by(Category.name))).all()
        return tuple(categories)
