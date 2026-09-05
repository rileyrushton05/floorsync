import logging
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.types import ASGIApp

from floorsync_api.main import add_global_middleware, create_application
from floorsync_common.settings import Settings


def make_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test",
        "allowed_hosts": ["testserver"],
        "cors_allowed_origins": ["https://frontend.example"],
        "max_request_body_bytes": 1024,
        "trust_request_id_header": False,
    }
    values.update(overrides)
    return Settings(**values)


def make_application(config: Settings) -> tuple[FastAPI, ASGIApp]:
    application = create_application(config)
    return application, add_global_middleware(application, config)


def test_request_context_adds_id_and_completion_log(caplog: pytest.LogCaptureFixture) -> None:
    _, application = make_application(make_settings())

    with caplog.at_level(logging.INFO, logger="floorsync_api.middleware.request_context"):
        response = TestClient(application).get("/health")

    request_id = response.headers["x-request-id"]
    assert UUID(request_id)
    records = [
        record
        for record in caplog.records
        if getattr(record, "event", None) == "http_request_completed"
    ]
    assert len(records) == 1
    assert records[0].request_id == request_id
    assert records[0].route == "/health"
    assert records[0].status_code == 200


def test_request_id_is_only_accepted_from_a_trusted_upstream() -> None:
    supplied_request_id = str(uuid4())
    _, untrusted_application = make_application(make_settings(trust_request_id_header=False))
    _, trusted_application = make_application(make_settings(trust_request_id_header=True))

    untrusted_response = TestClient(untrusted_application).get(
        "/health",
        headers={"X-Request-ID": supplied_request_id},
    )
    trusted_response = TestClient(trusted_application).get(
        "/health",
        headers={"X-Request-ID": supplied_request_id},
    )

    assert untrusted_response.headers["x-request-id"] != supplied_request_id
    assert trusted_response.headers["x-request-id"] == supplied_request_id


def test_oversized_request_uses_problem_details() -> None:
    inner, application = make_application(make_settings(max_request_body_bytes=4))

    @inner.post("/read-body")
    async def read_body(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    response = TestClient(application).post(
        "/read-body",
        content=b"12345",
        headers={"Content-Type": "application/octet-stream"},
    )

    assert response.status_code == 413
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["type"] == "urn:floorsync:problem:request-body-too-large"
    assert "x-request-id" in response.headers


def test_unhandled_exception_is_sanitized_and_keeps_cors() -> None:
    inner, application = make_application(make_settings())

    @inner.get("/fail")
    def fail() -> None:
        raise RuntimeError("private database detail")

    response = TestClient(application, raise_server_exceptions=False).get(
        "/fail",
        headers={"Origin": "https://frontend.example"},
    )

    assert response.status_code == 500
    assert response.headers["content-type"] == "application/problem+json"
    assert response.headers["access-control-allow-origin"] == "https://frontend.example"
    assert "x-request-id" in response.headers
    assert response.json() == {
        "type": "urn:floorsync:problem:internal-server-error",
        "title": "Internal Server Error",
        "status": 500,
        "detail": "An unexpected error occurred.",
        "instance": "/fail",
    }
    assert "private database detail" not in response.text


def test_invalid_host_is_rejected() -> None:
    _, application = make_application(make_settings())

    response = TestClient(application).get(
        "/health",
        headers={"Host": "attacker.example"},
    )

    assert response.status_code == 400
    assert "x-request-id" in response.headers


def test_cors_preflight_is_correlated() -> None:
    _, application = make_application(make_settings())

    response = TestClient(application).options(
        "/health",
        headers={
            "Origin": "https://frontend.example",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://frontend.example"
    assert "x-request-id" in response.headers
