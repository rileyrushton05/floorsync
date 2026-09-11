from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse

from floorsync_api.dependencies.authentication import require_roles
from floorsync_api.dependencies.database import DbSession
from floorsync_api.features.machines.schemas import (
    CapabilityResponse,
    CapabilityUpsertRequest,
    CategoryCreateRequest,
    CategoryResponse,
    MachineCreateRequest,
    MachineDetailResponse,
    MachineResponse,
    MachineUpdateRequest,
)
from floorsync_api.problems import ProblemDetail, problem_response
from floorsync_api.schemas import CursorPage
from floorsync_common.database.models.user import User
from floorsync_common.machines.results import (
    CapabilitiesListed,
    CapabilityNotFound,
    CapabilityRemoved,
    CapabilitySet,
    CategoryCreated,
    CategoryNameAlreadyExists,
    CategoryNotFound,
    MachineCreated,
    MachineFound,
    MachineNameAlreadyExists,
    MachineNotFound,
    MachineUpdated,
)
from floorsync_common.machines.service import CategoryService, MachineService
from floorsync_common.operations.results import OperationNotFound
from floorsync_common.partial import UNSET

router = APIRouter(prefix="/machines", tags=["machines"])
categories_router = APIRouter(prefix="/categories", tags=["machines"])
Manager = Annotated[User, Depends(require_roles("manager"))]


@router.post(
    "",
    response_model=MachineResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a machine",
    responses={
        409: {"description": "A machine already uses that name"},
        422: {"description": "The referenced category does not exist"},
    },
)
async def create_machine(
    command: MachineCreateRequest,
    request: Request,
    response: Response,
    db: DbSession,
    _: Manager,
) -> MachineResponse | JSONResponse:
    """Add a machine the scheduler can assign work to."""

    async with db.begin():
        result = await MachineService.create_machine(
            db,
            name=command.name,
            category_id=command.category_id,
            salary=command.salary,
            active=command.active,
        )

        match result:
            case MachineCreated(machine=machine):
                response.headers["Location"] = f"/api/v1/machines/{machine.id}"
                return MachineResponse.model_validate(machine)
            case MachineNameAlreadyExists(name=name):
                return _machine_name_conflict(request, name)
            case CategoryNotFound(category_id=category_id):
                return _category_reference_invalid(request, category_id)
            case _:
                assert_never(result)


@router.get(
    "",
    response_model=CursorPage[MachineResponse],
    summary="List machines",
)
async def list_machines(
    db: DbSession,
    _: Manager,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
) -> CursorPage[MachineResponse]:
    """List machines by name, a page at a time."""

    async with db.begin():
        page = await MachineService.list_machines(db, limit=limit, cursor=cursor)

    return CursorPage[MachineResponse](
        items=[MachineResponse.model_validate(machine) for machine in page.machines],
        next_cursor=page.next_cursor,
    )


@router.get(
    "/{machine_id}",
    response_model=MachineDetailResponse,
    summary="Get a machine and its capabilities",
)
async def get_machine(machine_id: UUID, db: DbSession, _: Manager) -> MachineDetailResponse:
    """Read one machine together with the operations it can run."""

    async with db.begin():
        result = await MachineService.get_machine(db, machine_id)

        match result:
            case MachineFound(machine=machine, capabilities=capabilities):
                return MachineDetailResponse(
                    **MachineResponse.model_validate(machine).model_dump(),
                    capabilities=[
                        CapabilityResponse.model_validate(capability) for capability in capabilities
                    ],
                )
            case MachineNotFound():
                raise _machine_not_found()
            case _:
                assert_never(result)


@router.patch(
    "/{machine_id}",
    response_model=MachineResponse,
    summary="Update a machine",
    responses={
        409: {"description": "A machine already uses that name"},
        422: {"description": "The referenced category does not exist"},
    },
)
async def update_machine(
    machine_id: UUID,
    command: MachineUpdateRequest,
    request: Request,
    db: DbSession,
    _: Manager,
) -> MachineResponse | JSONResponse:
    """Apply a partial update, including decommissioning through `active`.

    There is no delete: a machine with recorded history cannot be removed, so retiring one is a
    status change. See the deletion policy in docs/database-schema.md.
    """

    changes = command.model_dump(exclude_unset=True)

    async with db.begin():
        result = await MachineService.update_machine(
            db,
            machine_id,
            name=changes.get("name", UNSET),
            category_id=changes.get("category_id", UNSET),
            salary=changes.get("salary", UNSET),
            active=changes.get("active", UNSET),
        )

        match result:
            case MachineUpdated(machine=machine):
                return MachineResponse.model_validate(machine)
            case MachineNotFound():
                raise _machine_not_found()
            case MachineNameAlreadyExists(name=name):
                return _machine_name_conflict(request, name)
            case CategoryNotFound(category_id=category_id):
                return _category_reference_invalid(request, category_id)
            case _:
                assert_never(result)


@router.get(
    "/{machine_id}/capabilities",
    response_model=list[CapabilityResponse],
    summary="List what a machine can run",
)
async def list_capabilities(
    machine_id: UUID,
    db: DbSession,
    _: Manager,
) -> list[CapabilityResponse]:
    """List the operations this machine is declared able to run."""

    async with db.begin():
        result = await MachineService.list_capabilities(db, machine_id)

        match result:
            case CapabilitiesListed(capabilities=capabilities):
                return [
                    CapabilityResponse.model_validate(capability) for capability in capabilities
                ]
            case MachineNotFound():
                raise _machine_not_found()
            case _:
                assert_never(result)


@router.put(
    "/{machine_id}/capabilities/{operation_id}",
    response_model=CapabilityResponse,
    summary="Declare what it costs this machine to run an operation",
)
async def set_capability(
    machine_id: UUID,
    operation_id: UUID,
    command: CapabilityUpsertRequest,
    response: Response,
    db: DbSession,
    _: Manager,
) -> CapabilityResponse:
    """Create or replace one operation-machine pairing.

    Idempotent, as `PUT` requires: re-sending a pairing restates its cost rather than failing.
    """

    async with db.begin():
        result = await MachineService.set_capability(
            db,
            machine_id,
            operation_id,
            duration=command.duration,
            energy=command.energy,
        )

        match result:
            case CapabilitySet(capability=capability, created=created):
                if created:
                    response.status_code = status.HTTP_201_CREATED
                    response.headers["Location"] = (
                        f"/api/v1/machines/{machine_id}/capabilities/{operation_id}"
                    )
                return CapabilityResponse.model_validate(capability)
            case MachineNotFound():
                raise _machine_not_found()
            case OperationNotFound():
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Operation not found.",
                )
            case _:
                assert_never(result)


@router.delete(
    "/{machine_id}/capabilities/{operation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Withdraw a machine's ability to run an operation",
)
async def remove_capability(
    machine_id: UUID,
    operation_id: UUID,
    db: DbSession,
    _: Manager,
) -> None:
    """Remove one operation-machine pairing."""

    async with db.begin():
        result = await MachineService.remove_capability(db, machine_id, operation_id)

        match result:
            case CapabilityRemoved():
                return None
            case CapabilityNotFound():
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Capability not found.",
                )
            case _:
                assert_never(result)


@categories_router.post(
    "",
    response_model=CategoryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a machine category",
    responses={409: {"description": "A category already uses that name"}},
)
async def create_category(
    command: CategoryCreateRequest,
    request: Request,
    response: Response,
    db: DbSession,
    _: Manager,
) -> CategoryResponse | JSONResponse:
    """Add a grouping machines can be assigned to."""

    async with db.begin():
        result = await CategoryService.create_category(db, name=command.name)

        match result:
            case CategoryCreated(category=category):
                response.headers["Location"] = f"/api/v1/categories/{category.id}"
                return CategoryResponse.model_validate(category)
            case CategoryNameAlreadyExists(name=name):
                return problem_response(
                    ProblemDetail(
                        type="urn:floorsync:problem:category-name-conflict",
                        title="Category name already in use",
                        status=status.HTTP_409_CONFLICT,
                        detail=f"A category named {name!r} already exists.",
                        instance=request.url.path,
                    )
                )
            case _:
                assert_never(result)


@categories_router.get(
    "",
    response_model=list[CategoryResponse],
    summary="List machine categories",
)
async def list_categories(db: DbSession, _: Manager) -> list[CategoryResponse]:
    """List every category. Small and bounded, so it is returned whole rather than paged."""

    async with db.begin():
        categories = await CategoryService.list_categories(db)

    return [CategoryResponse.model_validate(category) for category in categories]


def _machine_not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found.")


def _machine_name_conflict(request: Request, name: str) -> JSONResponse:
    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:machine-name-conflict",
            title="Machine name already in use",
            status=status.HTTP_409_CONFLICT,
            detail=f"A machine named {name!r} already exists.",
            instance=request.url.path,
        )
    )


def _category_reference_invalid(request: Request, category_id: UUID) -> JSONResponse:
    """A body field naming a category that does not exist is unprocessable, not a missing page."""

    return problem_response(
        ProblemDetail(
            type="urn:floorsync:problem:category-not-found",
            title="Referenced category does not exist",
            status=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"No category exists with id {category_id}.",
            instance=request.url.path,
        )
    )
