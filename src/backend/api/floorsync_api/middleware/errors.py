import logging

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)


class UnhandledExceptionMiddleware:
    """Log unexpected failures once and return a sanitized Problem Details response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        response_started = False

        async def capture_response_start(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive, capture_response_start)
        except Exception:
            logger.exception(
                "Unhandled application exception",
                extra={"event": "unhandled_application_exception"},
            )
            if response_started:
                raise

            response = JSONResponse(
                status_code=500,
                media_type="application/problem+json",
                content={
                    "type": "urn:floorsync:problem:internal-server-error",
                    "title": "Internal Server Error",
                    "status": 500,
                    "detail": "An unexpected error occurred.",
                    "instance": scope["path"],
                },
            )
            await response(scope, receive, send)
