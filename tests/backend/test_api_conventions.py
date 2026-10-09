import ast
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from floorsync_api.problems import install_problem_handlers
from floorsync_api.schemas import CursorPage, RequestSchema, ResponseSchema

API_PACKAGE = Path(__file__).resolve().parents[2] / "src" / "backend" / "api" / "floorsync_api"
# Found by what they do, not what they are called: every module that creates an `APIRouter`.
ROUTE_MODULES = sorted(
    path for path in API_PACKAGE.rglob("*.py") if "APIRouter(" in path.read_text()
)
SQL_IN_ROUTES_ALLOWED = {
    # A readiness probe exists to ask the database "are you there?" directly.
    "routers/health.py",
}


def test_http_errors_use_problem_details() -> None:
    app = FastAPI()
    install_problem_handlers(app)

    response = TestClient(app).get("/missing")

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json() == {
        "type": "about:blank",
        "title": "Not Found",
        "status": 404,
        "detail": "Not Found",
        "instance": "/missing",
    }


def test_validation_errors_identify_invalid_parameters() -> None:
    app = FastAPI()
    install_problem_handlers(app)

    @app.get("/api/v1/examples/{example_id}")
    def get_example(example_id: int) -> dict[str, int]:
        return {"id": example_id}

    response = TestClient(app).get("/api/v1/examples/not-an-integer")

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["type"] == "urn:floorsync:problem:request-validation"
    assert response.json()["invalid_params"] == [
        {
            "name": "path.example_id",
            "reason": "Input should be a valid integer, unable to parse string as an integer",
        }
    ]


def test_request_and_response_schema_defaults_enforce_contract_boundaries() -> None:
    class ExampleRequest(RequestSchema):
        name: str

    class ExampleResponse(ResponseSchema):
        name: str

    class ExampleObject:
        name = "Floor plan"

    with pytest.raises(ValidationError):
        ExampleRequest.model_validate({"name": "Floor plan", "unexpected": True})

    response = ExampleResponse.model_validate(ExampleObject())
    page = CursorPage[ExampleResponse](items=[response])

    assert response.name == "Floor plan"
    assert page.model_dump() == {
        "items": [{"name": "Floor plan"}],
        "next_cursor": None,
    }


def _imported_modules(module: Path) -> set[str]:
    imported: set[str] = set()
    for node in ast.walk(ast.parse(module.read_text())):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            imported.add(node.module)
    return imported


def _uses_sqlalchemy(module: Path) -> bool:
    return any(name.split(".")[0] == "sqlalchemy" for name in _imported_modules(module))


@pytest.mark.parametrize(
    "router",
    [
        path
        for path in ROUTE_MODULES
        if path.relative_to(API_PACKAGE).as_posix() not in SQL_IN_ROUTES_ALLOWED
    ],
    ids=lambda path: path.relative_to(API_PACKAGE).as_posix(),
)
def test_routers_never_build_sql(router: Path) -> None:
    """SQL belongs in a service; a route calls the service and maps its result (#306)."""

    assert not _uses_sqlalchemy(router)


@pytest.mark.parametrize("allowed", sorted(SQL_IN_ROUTES_ALLOWED))
def test_every_router_allowed_sql_still_needs_it(allowed: str) -> None:
    """An exemption that is no longer used is removed, so the list stays a list of real reasons."""

    assert _uses_sqlalchemy(API_PACKAGE / allowed)
