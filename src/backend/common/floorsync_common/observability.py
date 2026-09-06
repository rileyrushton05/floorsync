from __future__ import annotations

import json
import logging
from contextvars import ContextVar, Token
from datetime import UTC, datetime
from typing import Any, Final

from floorsync_common.settings import Settings

request_id_context: ContextVar[str | None] = ContextVar("request_id", default=None)

_STANDARD_LOG_RECORD_FIELDS: Final = frozenset(
    logging.LogRecord(
        name="",
        level=0,
        pathname="",
        lineno=0,
        msg="",
        args=(),
        exc_info=None,
    ).__dict__
)


def set_request_id(request_id: str) -> Token[str | None]:
    """Set request correlation for the current async context."""

    return request_id_context.set(request_id)


def reset_request_id(token: Token[str | None]) -> None:
    """Restore request correlation after the current operation finishes."""

    request_id_context.reset(token)


class ContextFilter(logging.Filter):
    """Attach stable service and request context to every log record."""

    def __init__(self, *, environment: str, service_name: str) -> None:
        super().__init__()
        self.environment = environment
        self.service_name = service_name

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "service"):
            record.service = self.service_name
        if not hasattr(record, "environment"):
            record.environment = self.environment
        if not hasattr(record, "request_id"):
            record.request_id = request_id_context.get()
        return True


class JsonFormatter(logging.Formatter):
    """Render one machine-readable JSON object per log record."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        for name, value in record.__dict__.items():
            if name not in _STANDARD_LOG_RECORD_FIELDS and not name.startswith("_"):
                payload[name] = value

        if record.exc_info is not None:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=str, separators=(",", ":"))


def configure_logging(config: Settings, *, service_name: str) -> None:
    """Configure application-owned logging for API and worker processes."""

    handler = logging.StreamHandler()
    handler.addFilter(
        ContextFilter(
            environment=config.environment,
            service_name=service_name,
        )
    )
    if config.log_format == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s %(name)s request_id=%(request_id)s %(message)s"
            )
        )

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(config.log_level)

    # RequestContextMiddleware emits the canonical HTTP completion event.
    logging.getLogger("uvicorn.access").disabled = True
