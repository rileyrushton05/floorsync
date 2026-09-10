"""Expected outcomes for machine, category and capability operations.

Every variant a caller must handle is a concrete type rather than an exception, so the web edge can
match exhaustively and map each one to its own status code. See docs/backend-conventions.md.
"""

from dataclasses import dataclass
from uuid import UUID

from floorsync_common.database.models.category import Category
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.machine import Machine
from floorsync_common.outcomes import ExpectedOutcome


@dataclass(frozen=True, slots=True)
class MachineCreated:
    machine: Machine


@dataclass(frozen=True, slots=True)
class MachineUpdated:
    machine: Machine


@dataclass(frozen=True, slots=True)
class MachineFound:
    machine: Machine
    capabilities: tuple[Compatibility, ...]


@dataclass(frozen=True, slots=True)
class MachineNotFound(ExpectedOutcome):
    machine_id: UUID


@dataclass(frozen=True, slots=True)
class MachineNameAlreadyExists(ExpectedOutcome):
    """`machines.name` is unique, so a second machine cannot reuse a name already in service."""

    name: str


@dataclass(frozen=True, slots=True)
class CategoryNotFound(ExpectedOutcome):
    category_id: UUID


type CreateMachineResult = MachineCreated | MachineNameAlreadyExists | CategoryNotFound
type GetMachineResult = MachineFound | MachineNotFound
type UpdateMachineResult = (
    MachineUpdated | MachineNotFound | MachineNameAlreadyExists | CategoryNotFound
)


@dataclass(frozen=True, slots=True)
class CapabilitiesListed:
    capabilities: tuple[Compatibility, ...]


@dataclass(frozen=True, slots=True)
class CapabilitySet:
    capability: Compatibility
    created: bool


@dataclass(frozen=True, slots=True)
class CapabilityRemoved:
    machine_id: UUID
    operation_id: UUID


@dataclass(frozen=True, slots=True)
class CapabilityNotFound(ExpectedOutcome):
    machine_id: UUID
    operation_id: UUID


@dataclass(frozen=True, slots=True)
class OperationNotFound(ExpectedOutcome):
    operation_id: UUID


type ListCapabilitiesResult = CapabilitiesListed | MachineNotFound
type SetCapabilityResult = CapabilitySet | MachineNotFound | OperationNotFound
type RemoveCapabilityResult = CapabilityRemoved | CapabilityNotFound


@dataclass(frozen=True, slots=True)
class CategoryCreated:
    category: Category


@dataclass(frozen=True, slots=True)
class CategoryNameAlreadyExists(ExpectedOutcome):
    name: str


type CreateCategoryResult = CategoryCreated | CategoryNameAlreadyExists
