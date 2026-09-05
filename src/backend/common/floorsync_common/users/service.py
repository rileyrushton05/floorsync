from datetime import UTC, datetime
from uuid import UUID

from pwdlib import PasswordHash
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.models.user import User
from floorsync_common.database.models.user_credential import UserCredential
from floorsync_common.users.results import (
    ActiveUserFound,
    ActiveUserNotFound,
    AuthenticateUserResult,
    AuthenticationSucceeded,
    GetActiveUserResult,
    InvalidCredentials,
)


class UserService:
    """Stateless user and credential operations with caller-owned transactions."""

    @staticmethod
    def hash_password(password: str) -> str:
        return PasswordHash.recommended().hash(password)

    @staticmethod
    def verify_password(password: str, password_hash: str) -> bool:
        return PasswordHash.recommended().verify(password, password_hash)

    @staticmethod
    async def authenticate(
        db: AsyncSession,
        *,
        username: str,
        password: str,
    ) -> AuthenticateUserResult:
        """Authenticate an active credential and record its successful use."""

        normalized_username = username.strip().lower()
        result = await db.execute(
            select(User, UserCredential)
            .join(UserCredential, UserCredential.user_id == User.id)
            .where(UserCredential.username == normalized_username)
        )
        row = result.tuples().one_or_none()
        if row is None:
            return InvalidCredentials(username=normalized_username)

        user, credential = row
        if not credential.active or not UserService.verify_password(
            password, credential.password_hash
        ):
            return InvalidCredentials(username=normalized_username)

        credential.last_authenticated_at = datetime.now(UTC)
        return AuthenticationSucceeded(user=user)

    @staticmethod
    async def get_active_user(db: AsyncSession, *, user_id: UUID) -> GetActiveUserResult:
        """Load only a user whose associated credential is currently active."""

        result = await db.execute(
            select(User)
            .join(UserCredential, UserCredential.user_id == User.id)
            .where(User.id == user_id, UserCredential.active.is_(True))
        )
        user = result.scalar_one_or_none()
        if user is None:
            return ActiveUserNotFound(user_id=user_id)
        return ActiveUserFound(user=user)
