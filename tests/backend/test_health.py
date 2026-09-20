from typing import Any

import pytest
from fastapi.testclient import TestClient

from floorsync_api.features.live_updates.health import LiveUpdateHealthReport
from floorsync_api.main import app, application
from floorsync_api.routers import health


class _FakeProcess:
    def __init__(self, *, running: bool) -> None:
        self.running = running


def _stub_live_update_state(monkeypatch: pytest.MonkeyPatch, *, running: bool = True) -> None:
    """`/health/live-updates` reads these off `app.state`, normally set by `lifespan()`."""

    monkeypatch.setattr(
        application.state, "live_update_subscriber", _FakeProcess(running=running), raising=False
    )
    monkeypatch.setattr(
        application.state, "live_update_relay", _FakeProcess(running=running), raising=False
    )


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


def test_live_updates_health_reports_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_live_update_state(monkeypatch)

    async def fake_build_report(**_: Any) -> LiveUpdateHealthReport:
        return LiveUpdateHealthReport(
            status="ok",
            redis_reachable=True,
            subscriber_running=True,
            relay_running=True,
            active_sockets=0,
            active_subscriptions=0,
            unpublished_outbox_count=0,
            oldest_unpublished_age_seconds=None,
        )

    monkeypatch.setattr(health, "build_report", fake_build_report)

    response = TestClient(app).get("/health/live-updates")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_live_updates_health_reports_503_when_degraded(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_live_update_state(monkeypatch)

    async def fake_build_report(**_: Any) -> LiveUpdateHealthReport:
        return LiveUpdateHealthReport(
            status="degraded",
            redis_reachable=False,
            subscriber_running=True,
            relay_running=True,
            active_sockets=0,
            active_subscriptions=0,
            unpublished_outbox_count=5,
            oldest_unpublished_age_seconds=300.0,
        )

    monkeypatch.setattr(health, "build_report", fake_build_report)

    response = TestClient(app).get("/health/live-updates")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["redis_reachable"] is False
    assert body["unpublished_outbox_count"] == 5
