from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp

from floorsync_api.features.live_updates.outbox_relay import OutboxRelay
from floorsync_api.features.live_updates.redis_client import close_redis_client
from floorsync_api.features.live_updates.subscriber import RedisLiveUpdateSubscriber
from floorsync_api.features.live_updates.websocket import hub as live_update_hub
from floorsync_api.features.live_updates.websocket import router as live_updates_router
from floorsync_api.middleware import (
    RequestBodyLimitMiddleware,
    RequestContextMiddleware,
    UnhandledExceptionMiddleware,
)
from floorsync_api.problems import install_problem_handlers
from floorsync_api.routers.api import router as api_router
from floorsync_api.routers.health import router as health_router
from floorsync_common.database.session import engine
from floorsync_common.observability import configure_logging
from floorsync_common.settings import Settings, settings


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    subscriber = RedisLiveUpdateSubscriber(live_update_hub)
    relay = OutboxRelay()
    subscriber.start()
    relay.start()
    yield
    await relay.stop()
    await subscriber.stop()
    await engine.dispose()
    await close_redis_client()


def create_application(config: Settings) -> FastAPI:
    """Build the inner FastAPI application with deterministic middleware order."""

    middleware = [
        Middleware(UnhandledExceptionMiddleware),
        Middleware(
            TrustedHostMiddleware,
            allowed_hosts=config.allowed_hosts,
            www_redirect=False,
        ),
        Middleware(
            RequestBodyLimitMiddleware,
            max_body_size=config.max_request_body_bytes,
        ),
    ]
    application = FastAPI(
        title="FloorSync API",
        version="0.1.0",
        lifespan=lifespan,
        middleware=middleware,
    )
    application.state.settings = config
    install_problem_handlers(application)
    application.include_router(api_router)
    application.include_router(health_router)
    application.include_router(live_updates_router)
    return application


def add_global_middleware(application: ASGIApp, config: Settings) -> ASGIApp:
    """Wrap preflight, early rejection, and application responses consistently."""

    cors_application = CORSMiddleware(
        app=application,
        allow_origins=config.cors_allowed_origins,
        allow_methods=config.cors_allowed_methods,
        allow_headers=config.cors_allowed_headers,
        expose_headers=["X-Request-ID"],
        allow_credentials=False,
    )
    return RequestContextMiddleware(
        cors_application,
        trust_request_id_header=config.trust_request_id_header,
    )


configure_logging(settings, service_name="floorsync-api")
application = create_application(settings)
app = add_global_middleware(application, settings)
