import asyncio
from collections.abc import AsyncIterator
from typing import assert_never, cast
from uuid import uuid4

import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.dependencies.authentication import create_access_token, decode_access_token
from floorsync_common.database.models.user import User
from floorsync_common.database.models.user_credential import UserCredential
from floorsync_common.settings import Settings
from floorsync_common.users import AuthenticationSucceeded, InvalidCredentials, UserService


class FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(
        self,
        exception_type: object,
        exception: object,
        traceback: object,
    ) -> None:
        return None


class FakeResult:
    def __init__(self, user: User | None) -> None:
        self._user = user

    def scalar_one_or_none(self) -> User | None:
        return self._user


class FakeSession:
    def __init__(self, user: User | None) -> None:
        self._user = user

    def begin(self) -> FakeTransaction:
        return FakeTransaction()

    async def execute(self, _: object) -> FakeResult:
        return FakeResult(self._user)


class FakeAuthenticationResult:
    def __init__(self, row: tuple[User, UserCredential] | None) -> None:
        self._row = row

    def tuples(self) -> "FakeAuthenticationResult":
        return self

    def one_or_none(self) -> tuple[User, UserCredential] | None:
        return self._row


class FakeAuthenticationSession:
    def __init__(self, row: tuple[User, UserCredential] | None) -> None:
        self._row = row

    async def execute(self, _: object) -> FakeAuthenticationResult:
        return FakeAuthenticationResult(self._row)


def auth_application(user: User | None) -> FastAPI:
    from floorsync_api.dependencies.database import get_db_session
    from floorsync_api.main import create_application

    application = create_application(Settings(environment="test"))

    async def get_test_db_session() -> AsyncIterator[AsyncSession]:
        yield cast(AsyncSession, FakeSession(user))

    application.dependency_overrides[get_db_session] = get_test_db_session
    return application


def test_password_hashes_are_argon2_and_can_be_verified() -> None:
    password_hash = UserService.hash_password("correct horse battery staple")

    assert password_hash.startswith("$argon2")
    assert UserService.verify_password("correct horse battery staple", password_hash)
    assert not UserService.verify_password("incorrect password", password_hash)


def test_user_service_returns_a_named_authentication_outcome() -> None:
    user_id = uuid4()
    user = User(id=user_id, name="Plant Manager", role="manager")
    credential = UserCredential(
        user_id=user_id,
        username="manager",
        password_hash=UserService.hash_password("correct password"),
        active=True,
    )
    result = asyncio.run(
        UserService.authenticate(
            cast(AsyncSession, FakeAuthenticationSession((user, credential))),
            username="MANAGER",
            password="correct password",
        )
    )

    match result:
        case AuthenticationSucceeded(user=authenticated_user):
            assert authenticated_user is user
            assert credential.last_authenticated_at is not None
        case InvalidCredentials(username=username):
            raise AssertionError(
                f"expected authentication success, got invalid credentials for {username}"
            )
        case _:
            assert_never(result)


def test_access_tokens_bind_a_user_to_the_configured_issuer_and_audience() -> None:
    config = Settings(
        environment="test",
        jwt_secret_key="test-secret-key-that-is-long-enough-for-jwt",
        jwt_issuer="floorsync-test",
        jwt_audience="floorsync-test-client",
    )
    user_id = uuid4()

    token = create_access_token(user_id, config)
    payload = jwt.decode(
        token,
        config.jwt_secret_key,
        algorithms=["HS256"],
        audience=config.jwt_audience,
        issuer=config.jwt_issuer,
    )

    verified_token = decode_access_token(token, config)

    assert payload["sub"] == str(user_id)
    assert verified_token is not None
    assert verified_token.user_id == user_id


def test_access_tokens_reject_a_different_audience() -> None:
    config = Settings(
        environment="test",
        jwt_secret_key="test-secret-key-that-is-long-enough-for-jwt",
        jwt_issuer="floorsync-test",
        jwt_audience="floorsync-test-client",
    )
    token = create_access_token(uuid4(), config)
    wrong_audience_config = Settings(
        environment="test",
        jwt_secret_key=config.jwt_secret_key,
        jwt_issuer=config.jwt_issuer,
        jwt_audience="another-client",
    )

    assert decode_access_token(token, wrong_audience_config) is None


def test_production_rejects_the_checked_in_jwt_secret() -> None:
    try:
        Settings(environment="production")
    except ValueError as error:
        assert "JWT_SECRET_KEY" in str(error)
    else:
        raise AssertionError("production settings must reject the development JWT secret")


def test_authenticated_user_endpoint_loads_the_active_database_account() -> None:
    user_id = uuid4()
    user = User(
        id=user_id,
        name="Plant Manager",
        role="manager",
    )
    config = Settings(environment="test")
    token = create_access_token(user_id, config)

    response = TestClient(auth_application(user)).get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "id": str(user_id),
        "name": "Plant Manager",
        "role": "manager",
        "machine_id": None,
    }


def test_authenticated_user_endpoint_rejects_a_missing_bearer_token() -> None:
    response = TestClient(auth_application(None)).get("/api/v1/auth/me")

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
