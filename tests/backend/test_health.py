from fastapi.testclient import TestClient

from floorsync_api.main import app


def test_health_endpoint_reports_api_ready() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "api"}


def test_websocket_endpoint_accepts_connections() -> None:
    with TestClient(app).websocket_connect("/ws") as websocket:
        assert websocket.receive_json() == {"type": "connected"}
