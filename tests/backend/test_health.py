import pytest
from fastapi.testclient import TestClient

from floorsync_api.main import app
from floorsync_api.routers import health


def test_health_endpoint_reports_api_ready() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "api"}


def test_liveness_does_not_require_external_dependencies() -> None:
    response = TestClient(app).get("/health/live")

    assert response.status_code == 200
    assert response.json() == {"status": "live", "service": "api"}


def test_readiness_reports_required_dependency_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def database_is_ready() -> bool:
        return False

    # Kept local to avoid requiring PostgreSQL in the backend unit-test suite.
    monkeypatch.setattr(health, "database_is_ready", database_is_ready)

    response = TestClient(app).get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "service": "api"}


def test_websocket_endpoint_accepts_connections() -> None:
    with TestClient(app).websocket_connect("/ws") as websocket:
        assert websocket.receive_json() == {"type": "connected"}
