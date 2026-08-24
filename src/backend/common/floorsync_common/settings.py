from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str = "postgresql+asyncpg://floorsync:floorsync@postgres:5432/floorsync"
    database_sync_url: str | None = None
    celery_broker_url: str = "redis://redis:6379/1"
    redis_url: str = "redis://redis:6379/0"


settings = Settings()
