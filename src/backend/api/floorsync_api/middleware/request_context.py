import logging
from time import perf_counter
from uuid import UUID, uuid4

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from floorsync_common.observability import reset_request_id, set_request_id

logger = logging.getLogger(__name__)


class RequestContextMiddleware:
    """Correlate and record HTTP requests without reading their bodies."""

    def __init__(self, app: ASGIApp, *, trust_request_id_header: bool = False) -> None:
        self.app = app
        self.trust_request_id_header = trust_request_id_header

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = self._request_id(scope)
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        token = set_request_id(request_id)
        started_at = perf_counter()
        status_code = 500

        async def send_with_request_id(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        finally:
            duration_ms = round((perf_counter() - started_at) * 1000, 3)
            route = scope.get("route")
            route_template = getattr(route, "path", "<unmatched>")
            log_level = logging.DEBUG if route_template.startswith("/health/") else logging.INFO
            try:
                logger.log(
                    log_level,
                    "HTTP request completed",
                    extra={
                        "event": "http_request_completed",
                        "method": scope["method"],
                        "route": route_template,
                        "status_code": status_code,
                        "duration_ms": duration_ms,
                    },
                )
            finally:
                reset_request_id(token)

    def _request_id(self, scope: Scope) -> str:
        if self.trust_request_id_header:
            supplied = Headers(scope=scope).get("x-request-id")
            if supplied is not None:
                try:
                    return str(UUID(supplied))
                except ValueError:
                    pass

        return str(uuid4())
