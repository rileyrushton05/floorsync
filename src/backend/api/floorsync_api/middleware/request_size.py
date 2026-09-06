from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class _RequestBodyTooLarge(Exception):
    pass


class RequestBodyLimitMiddleware:
    """Reject oversized HTTP bodies with the API's Problem Details format."""

    def __init__(self, app: ASGIApp, *, max_body_size: int) -> None:
        if max_body_size <= 0:
            raise ValueError("max_body_size must be positive")
        self.app = app
        self.max_body_size = max_body_size

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        content_length = self._content_length(scope)
        if content_length is not None and content_length > self.max_body_size:
            await self._send_problem(scope, receive, send)
            return

        received_bytes = 0
        response_started = False

        async def receive_with_limit() -> Message:
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.max_body_size:
                    raise _RequestBodyTooLarge
            return message

        async def capture_response_start(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive_with_limit, capture_response_start)
        except _RequestBodyTooLarge:
            if response_started:
                raise
            await self._send_problem(scope, receive, send)

    @staticmethod
    def _content_length(scope: Scope) -> int | None:
        for name, value in scope["headers"]:
            if name.lower() == b"content-length":
                try:
                    return int(value)
                except ValueError:
                    return None
        return None

    @staticmethod
    async def _send_problem(scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse(
            status_code=413,
            media_type="application/problem+json",
            content={
                "type": "urn:floorsync:problem:request-body-too-large",
                "title": "Content Too Large",
                "status": 413,
                "detail": "The request body exceeds the configured size limit.",
                "instance": scope["path"],
            },
        )
        await response(scope, receive, send)
