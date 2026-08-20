import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from floorsync_api.problems import install_problem_handlers
from floorsync_api.schemas import CursorPage, RequestSchema, ResponseSchema


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
