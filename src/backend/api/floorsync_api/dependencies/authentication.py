from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal, assert_never
from uuid import UUID, uuid4

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jwt.exceptions import InvalidTokenError

from floorsync_api.dependencies.database import DbSession
from floorsync_common.database.models.user import User
from floorsync_common.settings import Settings
from floorsync_common.users import ActiveUserFound, ActiveUserNotFound, UserService

type UserRole = Literal["manager", "operator"]

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/token")


@dataclass(frozen=True, slots=True)
class AccessTokenSubject:
    user_id: UUID


def create_access_token(user_id: UUID, settings: Settings) -> str:
    """Issue a short-lived, audience-bound access token for a local user."""

    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "iat": now,
        "exp": now + timedelta(minutes=settings.jwt_access_token_expire_minutes),
        "jti": str(uuid4()),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm="HS256")


def decode_access_token(token: str, settings: Settings) -> AccessTokenSubject | None:
    """Verify the JWT claims necessary to authenticate a FloorSync API request."""

    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=["HS256"],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
            options={"require": ["sub", "iss", "aud", "iat", "exp", "jti"]},
        )
        user_id = UUID(payload["sub"])
    except (InvalidTokenError, KeyError, TypeError, ValueError):
        return None
    return AccessTokenSubject(user_id=user_id)


def unauthenticated() -> HTTPException:
    """Return a standards-compatible response for invalid bearer tokens."""

    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials.",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user(
    request: Request,
    token: Annotated[str, Depends(oauth2_scheme)],
    db: DbSession,
) -> User:
    """Verify a token, then load its active account through the user application service."""

    config: Settings = request.app.state.settings
    subject = decode_access_token(token, config)
    if subject is None:
        raise unauthenticated()

    async with db.begin():
        result = await UserService.get_active_user(db, user_id=subject.user_id)
    match result:
        case ActiveUserFound(user=user):
            return user
        case ActiveUserNotFound():
            raise unauthenticated()
        case _:
            assert_never(result)


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_roles(*roles: UserRole) -> Callable[[User], Awaitable[User]]:
    """Create a dependency that admits only one of the specified application roles."""

    async def verify_role(current_user: CurrentUser) -> User:
        if current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions.",
            )
        return current_user

    return verify_role


async def require_machine_access(machine_id: UUID, current_user: CurrentUser) -> User:
    """Limit operators to their assigned machine while allowing manager oversight."""

    if current_user.role == "operator" and current_user.machine_id != machine_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account cannot access that machine.",
        )
    return current_user
