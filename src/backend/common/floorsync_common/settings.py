from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: Literal["development", "test", "staging", "production"] = "development"
    log_level: str = "INFO"
    log_format: Literal["human", "json"] = "human"

    database_url: str = "postgresql+asyncpg://floorsync:floorsync@postgres:5432/floorsync"
    database_sync_url: str | None = None
    celery_broker_url: str = "redis://redis:6379/1"
    redis_url: str = "redis://redis:6379/0"

    cors_allowed_origins: list[str] = ["http://localhost:3000"]
    cors_allowed_methods: list[str] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    cors_allowed_headers: list[str] = [
        "Accept",
        "Authorization",
        "Content-Type",
        "X-Request-ID",
    ]
    allowed_hosts: list[str] = ["localhost", "127.0.0.1", "testserver", "api"]
    max_request_body_bytes: int = Field(default=1_048_576, gt=0)
    trust_request_id_header: bool = False
    readiness_timeout_seconds: float = Field(default=1.0, gt=0)

    jwt_secret_key: str = "development-only-change-this-jwt-secret-key"
    jwt_issuer: str = "floorsync-api"
    jwt_audience: str = "floorsync-frontend"
    jwt_access_token_expire_minutes: int = Field(default=30, gt=0, le=1_440)

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, value: str) -> str:
        normalized = value.upper()
        if normalized not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError("must be DEBUG, INFO, WARNING, ERROR, or CRITICAL")
        return normalized

    @model_validator(mode="after")
    def validate_production_jwt_secret(self) -> "Settings":
        """Prevent the checked-in development secret from protecting production tokens."""

        if self.environment == "production" and (
            self.jwt_secret_key == "development-only-change-this-jwt-secret-key"
            or len(self.jwt_secret_key) < 32
        ):
            raise ValueError(
                "JWT_SECRET_KEY must be a unique value of at least 32 characters in production"
            )
        return self


settings = Settings()
