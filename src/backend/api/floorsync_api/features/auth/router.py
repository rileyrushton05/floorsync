from typing import Annotated, assert_never

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm

from floorsync_api.dependencies.authentication import CurrentUser
from floorsync_api.dependencies.authentication import create_access_token as issue_access_token
from floorsync_api.dependencies.database import DbSession
from floorsync_api.features.auth.schemas import AccessTokenResponse, CurrentUserResponse
from floorsync_common.users import AuthenticationSucceeded, InvalidCredentials, UserService

router = APIRouter(prefix="/auth", tags=["authentication"])


def invalid_credentials() -> HTTPException:
    """Return one response for all sign-in failures to avoid account enumeration."""

    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Incorrect username or password.",
        headers={"WWW-Authenticate": "Bearer"},
    )


@router.post(
    "/token",
    response_model=AccessTokenResponse,
    summary="Sign in and obtain a bearer token",
)
async def create_access_token(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: DbSession,
    request: Request,
) -> AccessTokenResponse:
    """Authenticate a local account using OAuth2-compatible form fields."""

    async with db.begin():
        result = await UserService.authenticate(
            db,
            username=form_data.username,
            password=form_data.password,
        )
    match result:
        case AuthenticationSucceeded(user=user):
            config = request.app.state.settings
            return AccessTokenResponse(
                access_token=issue_access_token(user.id, config),
                expires_in=config.jwt_access_token_expire_minutes * 60,
            )
        case InvalidCredentials():
            raise invalid_credentials()
        case _:
            assert_never(result)


@router.get(
    "/me",
    response_model=CurrentUserResponse,
    summary="Get the signed-in account",
)
async def get_current_user(current_user: CurrentUser) -> CurrentUserResponse:
    """Return the authenticated account without exposing password or token data."""

    return CurrentUserResponse.model_validate(current_user)
