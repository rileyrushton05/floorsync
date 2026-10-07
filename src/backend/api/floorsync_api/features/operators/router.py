from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse

from floorsync_api.dependencies.authentication import require_roles
from floorsync_api.dependencies.database import DbSession
from floorsync_api.features.operators.schemas import OperatorResponse, OperatorUpdateRequest
from floorsync_api.problems import ProblemDetail, problem_response
from floorsync_common.database.models.user import User
from floorsync_common.partial import UNSET
from floorsync_common.users import (
    AssignedMachineHasNoOperator,
    AssignedMachineNotFound,
    OperatorNotFound,
    OperatorService,
    OperatorUpdated,
    UsernameAlreadyExists,
)

router = APIRouter(prefix="/operators", tags=["operators"])
Manager = Annotated[User, Depends(require_roles("manager"))]


@router.get(
    "",
    response_model=list[OperatorResponse],
    summary="List operator logins",
)
async def list_operators(db: DbSession, _: Manager) -> list[OperatorResponse]:
    """List every operator login with the machine it runs.

    One per machine, so the collection is bounded by the floor and returned whole rather than paged.
    Operator logins are created with their machine; there is no route to create one on its own.
    """

    async with db.begin():
        accounts = await OperatorService.list_operators(db)

    return [OperatorResponse.from_account(account) for account in accounts]


@router.patch(
    "/{user_id}",
    response_model=OperatorResponse,
    summary="Update an operator login",
    responses={
        409: {"description": "Another login already uses that username"},
        422: {"description": "The machine does not exist or has no operator to swap with"},
    },
)
async def update_operator(
    user_id: UUID,
    command: OperatorUpdateRequest,
    request: Request,
    db: DbSession,
    _: Manager,
) -> OperatorResponse | JSONResponse:
    """Rename, re-password, enable or disable an operator, or swap its machine with another's.

    Disabling takes effect on the operator's next request, not when its current token expires.
    """

    changes = command.model_dump(exclude_unset=True)

    async with db.begin():
        result = await OperatorService.update_operator(
            db,
            user_id,
            name=changes.get("name", UNSET),
            username=changes.get("username", UNSET),
            password=changes.get("password", UNSET),
            active=changes.get("active", UNSET),
            machine_id=changes.get("machine_id", UNSET),
        )

        match result:
            case OperatorUpdated(account=account):
                return OperatorResponse.from_account(account)
            case OperatorNotFound():
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="Operator not found."
                )
            case UsernameAlreadyExists(username=username):
                return problem_response(
                    ProblemDetail(
                        type="urn:floorsync:problem:username-conflict",
                        title="Username already in use",
                        status=status.HTTP_409_CONFLICT,
                        detail=f"Another login already uses the username {username!r}.",
                        instance=request.url.path,
                    )
                )
            case AssignedMachineNotFound(machine_id=machine_id):
                return problem_response(
                    ProblemDetail(
                        type="urn:floorsync:problem:machine-not-found",
                        title="Referenced machine does not exist",
                        status=status.HTTP_422_UNPROCESSABLE_CONTENT,
                        detail=f"No machine exists with id {machine_id}.",
                        instance=request.url.path,
                    )
                )
            case AssignedMachineHasNoOperator(machine_id=machine_id):
                return problem_response(
                    ProblemDetail(
                        type="urn:floorsync:problem:machine-has-no-operator",
                        title="Machine has no operator to swap with",
                        status=status.HTTP_422_UNPROCESSABLE_CONTENT,
                        detail=(
                            "Operators can only swap machines with another operator, and that "
                            "machine has none."
                        ),
                        instance=request.url.path,
                    )
                )
            case _:
                assert_never(result)
