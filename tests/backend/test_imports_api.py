"""The import route's mapping (#297): status codes, the report, and when it rolls back.

The service is stubbed and the session faked, so what is tested is the route: a dry run answers
200 and keeps nothing, a real import answers 201, a refused one 422, and the transaction is rolled
back for everything except an applied, real import. The service against a real database is
`tests/integration/test_data_import.py`.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_common.database.models.user import User
from floorsync_common.imports.plan import ImportFormat, ImportIssue, ImportIssueCode, ImportPlan
from floorsync_common.imports.results import (
    ImportApplied,
    ImportPlanResult,
    ImportRejected,
    ImportSummary,
)
from floorsync_common.imports.service import ImportService
from floorsync_common.settings import Settings

VALID_FILE = json.dumps(
    {
        "format": "floorsync",
        "version": 1,
        "jobs": [
            {
                "name": "Panel",
                "operations": [{"name": "Cut", "routes": [{"machine": "Saw", "duration": 10}]}],
            }
        ],
    }
).encode()

SUMMARY = ImportSummary(
    format=ImportFormat.FLOORSYNC,
    machines_created=("Saw",),
    machines_reused=(),
    categories_created=(),
    jobs=1,
    operations=1,
    routes=1,
    dependencies=0,
)
WARNING = ImportIssue(ImportIssueCode.SIMILAR_MACHINE_NAME, "Saw looks like saw.", "machines[0]")


class FakeTransaction:
    def __init__(self, session: FakeSession) -> None:
        self.session = session

    async def __aenter__(self) -> FakeTransaction:
        return self

    async def __aexit__(self, *_: object) -> None:
        if not self.session.rolled_back:
            self.session.committed = True

    async def rollback(self) -> None:
        self.session.rolled_back = True


class FakeSession:
    def __init__(self) -> None:
        self.committed = False
        self.rolled_back = False

    def begin(self) -> FakeTransaction:
        return FakeTransaction(self)


class Calls:
    def __init__(self) -> None:
        self.plans: list[ImportPlan] = []
        self.operator_passwords: list[str] = []


@pytest.fixture
def session() -> FakeSession:
    return FakeSession()


def import_client(session: FakeSession, role: str = "manager") -> TestClient:
    from floorsync_api.main import create_application

    application: FastAPI = create_application(
        Settings(environment="test", operator_default_password="from-settings")
    )
    user = User(id=uuid4(), name="Ada Manager", role=role, machine_id=None)

    async def get_test_db_session() -> AsyncIterator[AsyncSession]:
        yield cast(AsyncSession, session)

    async def get_test_current_user() -> User:
        return user

    application.dependency_overrides[get_db_session] = get_test_db_session
    application.dependency_overrides[get_current_user] = get_test_current_user
    return TestClient(application)


def stub(monkeypatch: pytest.MonkeyPatch, outcome: ImportPlanResult) -> Calls:
    calls = Calls()

    async def fake(_db: object, plan: ImportPlan, *, operator_password: str) -> ImportPlanResult:
        calls.plans.append(plan)
        calls.operator_passwords.append(operator_password)
        return outcome

    monkeypatch.setattr(ImportService, "import_plan", staticmethod(fake))
    return calls


def upload(client: TestClient, raw: bytes, *, dry_run: bool = False) -> Any:
    return client.post(
        "/api/v1/imports",
        params={"dry_run": "true"} if dry_run else None,
        files={"file": ("floor.json", raw, "application/json")},
    )


def applied(job_ids: tuple[UUID, ...]) -> ImportApplied:
    return ImportApplied(summary=SUMMARY, job_ids=job_ids, warnings=(WARNING,))


def test_an_import_answers_201_with_the_new_jobs_and_commits(
    monkeypatch: pytest.MonkeyPatch, session: FakeSession
) -> None:
    job_id = uuid4()
    calls = stub(monkeypatch, applied((job_id,)))

    response = upload(import_client(session), VALID_FILE)

    assert response.status_code == 201
    assert "location" not in response.headers
    body = response.json()
    assert body["dry_run"] is False and body["importable"] is True
    assert body["format"] == "floorsync"
    assert body["job_ids"] == [str(job_id)]
    # New machines get their operator login with the configured default, as through POST /machines.
    assert calls.operator_passwords == ["from-settings"]
    assert body["summary"]["machines_created"] == ["Saw"]
    assert body["warnings"] == [
        {
            "code": "similar_machine_name",
            "message": "Saw looks like saw.",
            "location": "machines[0]",
        }
    ]
    assert calls.plans[0].jobs[0].name == "Panel"
    assert session.committed and not session.rolled_back


def test_a_dry_run_answers_200_reports_no_job_ids_and_rolls_back(
    monkeypatch: pytest.MonkeyPatch, session: FakeSession
) -> None:
    stub(monkeypatch, applied((uuid4(),)))

    response = upload(import_client(session), VALID_FILE, dry_run=True)

    assert response.status_code == 200
    body = response.json()
    assert body["dry_run"] is True and body["importable"] is True
    assert body["job_ids"] == []
    assert body["summary"]["jobs"] == 1
    assert session.rolled_back and not session.committed


def test_a_refused_import_is_a_422_problem_listing_every_issue_and_rolls_back(
    monkeypatch: pytest.MonkeyPatch, session: FakeSession
) -> None:
    issues = (
        ImportIssue(
            ImportIssueCode.UNKNOWN_MACHINE, "No machine 'Sawz'.", "jobs[0].operations[0].routes[0]"
        ),
        ImportIssue(
            ImportIssueCode.INVALID_VALUE, "Duration must be...", "jobs[1].operations[0].routes[0]"
        ),
    )
    stub(monkeypatch, ImportRejected(summary=SUMMARY, issues=issues, warnings=(WARNING,)))

    response = upload(import_client(session), VALID_FILE)

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["type"] == "urn:floorsync:problem:import-invalid"
    assert body["detail"] == "Found 2 problems in the file, so nothing was imported."
    assert [issue["code"] for issue in body["issues"]] == ["unknown_machine", "invalid_value"]
    assert body["warnings"][0]["code"] == "similar_machine_name"
    assert session.rolled_back and not session.committed


def test_a_refused_dry_run_still_answers_200_with_the_issues(
    monkeypatch: pytest.MonkeyPatch, session: FakeSession
) -> None:
    issue = ImportIssue(
        ImportIssueCode.INACTIVE_MACHINE, "Saw is inactive.", "jobs[0].operations[0].routes[0]"
    )
    stub(monkeypatch, ImportRejected(summary=SUMMARY, issues=(issue,), warnings=()))

    response = upload(import_client(session), VALID_FILE, dry_run=True)

    assert response.status_code == 200
    body = response.json()
    assert body["importable"] is False
    assert body["summary"]["machines_created"] == ["Saw"]
    assert [item["code"] for item in body["issues"]] == ["inactive_machine"]
    assert session.rolled_back


def test_an_unreadable_file_never_reaches_the_service(
    monkeypatch: pytest.MonkeyPatch, session: FakeSession
) -> None:
    calls = stub(monkeypatch, applied(()))
    client = import_client(session)

    refused = upload(client, b"not json")
    previewed = upload(client, b"not json", dry_run=True)

    assert refused.status_code == 422
    assert refused.json()["issues"][0]["code"] == "not_json"
    assert previewed.status_code == 200
    preview = previewed.json()
    assert (preview["format"], preview["summary"], preview["importable"]) == (None, None, False)
    assert preview["issues"][0]["code"] == "not_json"
    assert calls.plans == []


@pytest.mark.parametrize(
    "number", [b"1e999999999999999999999", b"1e5000000"], ids=["beyond-decimal", "huge-exponent"]
)
def test_an_extreme_number_is_a_structured_problem_and_never_reaches_the_service(
    monkeypatch: pytest.MonkeyPatch, session: FakeSession, number: bytes
) -> None:
    calls = stub(monkeypatch, applied(()))
    client = import_client(session)
    raw = VALID_FILE.replace(b'"duration": 10', b'"duration": ' + number)

    refused = upload(client, raw)
    previewed = upload(client, raw, dry_run=True)

    assert refused.status_code == 422, refused.text
    assert refused.json()["type"] == "urn:floorsync:problem:import-invalid"
    assert previewed.status_code == 200, previewed.text
    assert previewed.json()["importable"] is False
    assert calls.plans == []


def test_only_a_manager_may_import(monkeypatch: pytest.MonkeyPatch, session: FakeSession) -> None:
    calls = stub(monkeypatch, applied(()))

    response = upload(import_client(session, role="operator"), VALID_FILE)

    assert response.status_code == 403
    assert calls.plans == []


def test_a_request_without_a_file_is_a_validation_problem(session: FakeSession) -> None:
    response = import_client(session).post("/api/v1/imports")

    assert response.status_code == 422
    assert response.json()["type"] == "urn:floorsync:problem:request-validation"
