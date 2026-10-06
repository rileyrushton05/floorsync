"""Importing a file into a real PostgreSQL (#297, decision 0020).

What a fake session cannot show: rows landing beside a floor that already has data, an existing
machine reused and left exactly as it was, a dry run and a refused file leaving every table as it
found them, two imports racing to create the same machine, and the imported jobs being ready for
the same checks schedule generation runs, and editable in the job builder afterwards. Requests go
through the real route, so the multipart upload and the request size limit are part of the test.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Iterator
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from database_support import Sessions, run, transaction
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from floorsync_api.dependencies.authentication import get_current_user
from floorsync_api.dependencies.database import get_db_session
from floorsync_api.main import application
from floorsync_common.database.models.category import Category
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.user import User
from floorsync_common.imports.formats import read_import_file
from floorsync_common.imports.plan import ImportPlan
from floorsync_common.imports.results import ImportApplied, ImportPlanResult, PlanRead
from floorsync_common.imports.service import ImportService

REPO = Path(__file__).resolve().parents[2]
EXAMPLE = (REPO / "docs" / "examples" / "import-example.json").read_bytes()
SEED_DATA = REPO / "src" / "database" / "seed-data"
TABLES = (Category, Machine, Job, Operation, Compatibility, Dependency)


@pytest.fixture
def api(database_url: str) -> Iterator[TestClient]:
    """The real app, its sessions bound to the test database and its caller a signed-in manager."""
    engine = create_async_engine(database_url, poolclass=NullPool)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autobegin=False)

    async def db_session() -> AsyncIterator[AsyncSession]:
        async with sessions() as session:
            yield session

    async def manager() -> User:
        return User(id=uuid4(), name="Manager", role="manager")

    application.dependency_overrides[get_db_session] = db_session
    application.dependency_overrides[get_current_user] = manager
    try:
        yield TestClient(application)
    finally:
        application.dependency_overrides.clear()


def upload(client: TestClient, raw: bytes, *, dry_run: bool = False) -> Response:
    return client.post(
        "/api/v1/imports",
        params={"dry_run": "true"} if dry_run else None,
        files={"file": ("floor.json", raw, "application/json")},
    )


def benchmark(name: str) -> bytes:
    (path,) = SEED_DATA.glob(f"*/{name}.json")
    return path.read_bytes()


type Document = dict[str, Any]
"""A decoded JSON import file."""


def edited_example(edit: Callable[[Document], None]) -> bytes:
    document = json.loads(EXAMPLE)
    edit(document)
    return json.dumps(document).encode()


def counts(database_url: str) -> dict[str, int]:
    async def read(sessions: Sessions) -> dict[str, int]:
        async with transaction(sessions) as db:
            return {
                table.__tablename__: await db.scalar(select(func.count()).select_from(table)) or 0
                for table in TABLES
            }

    return run(database_url, read)


def add_machine(database_url: str, **values: Any) -> UUID:
    async def add(sessions: Sessions) -> UUID:
        async with transaction(sessions) as db:
            category_name = values.pop("category", None)
            if category_name is not None:
                category = Category(name=category_name)
                db.add(category)
                await db.flush()
                values["category_id"] = category.id
            machine = Machine(**values)
            db.add(machine)
            await db.flush()
            return machine.id

    return run(database_url, add)


def plan_of(raw: bytes) -> ImportPlan:
    result = read_import_file(raw)
    assert isinstance(result, PlanRead)
    return result.plan


def test_the_example_lands_beside_existing_data_and_leaves_a_reused_machine_alone(
    api: TestClient, database_url: str
) -> None:
    polisher = add_machine(
        database_url, name="Edge Polisher", salary=Decimal("30.00"), category="Finishing"
    )

    async def an_existing_job(sessions: Sessions) -> UUID:
        async with transaction(sessions) as db:
            existing = Job(name="Existing order")
            db.add(existing)
            await db.flush()
            operation = Operation(job_id=existing.id, name="Polish", position=1)
            db.add(operation)
            await db.flush()
            db.add(Compatibility(operation_id=operation.id, machine_id=polisher, duration=5))
            return existing.id

    existing_job = run(database_url, an_existing_job)

    response = upload(api, EXAMPLE)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["summary"] == {
        "machines_created": [
            "Cutting Table 1",
            "Cutting Table 2",
            "Laminating Press",
            "Tempering Furnace",
            "Inspection Bench",
        ],
        "machines_reused": ["Edge Polisher"],
        "categories_created": ["Cutting", "Laminating", "Tempering", "Quality"],
        "jobs": 3,
        "operations": 10,
        "routes": 11,
        "dependencies": 7,
    }
    assert sorted((item["code"], item["location"]) for item in body["warnings"]) == [
        ("machine_differs", "machines[2]"),
        ("resched_unsupported", "jobs[2]"),
    ]
    screen_id, _, door_id = (UUID(job_id) for job_id in body["job_ids"])

    async def check(sessions: Sessions) -> None:
        async with transaction(sessions) as db:
            reused = await db.get(Machine, polisher)
            assert reused is not None and reused.salary == Decimal("30.00")
            assert (
                await db.scalar(select(Category.name).where(Category.id == reused.category_id))
                == "Finishing"
            )
            cutting = await db.scalar(select(Machine).where(Machine.name == "Cutting Table 1"))
            assert cutting is not None and cutting.salary == Decimal("38.50") and cutting.active

            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(Operation)
                    .where(Operation.job_id == existing_job)
                )
                == 1
            )

            door = (
                await db.execute(
                    select(Operation.name, Operation.position)
                    .where(Operation.job_id == door_id)
                    .order_by(Operation.position)
                )
            ).all()
            assert [tuple(row) for row in door] == [
                ("Cut outer pane", 1),
                ("Cut inner pane", 2),
                ("Laminate", 3),
                ("Inspect", 4),
            ]

            async def origins(job_id: UUID) -> list[str]:
                rows = await db.scalars(
                    select(Dependency.origin)
                    .join(Operation, Operation.id == Dependency.after_operation_id)
                    .where(Operation.job_id == job_id)
                )
                return sorted(rows)

            assert await origins(screen_id) == ["builder_sequence"] * 3
            assert await origins(door_id) == ["external"] * 3

            energies = sorted(
                str(energy)
                for energy in await db.scalars(
                    select(Compatibility.energy)
                    .join(Operation, Operation.id == Compatibility.operation_id)
                    .where(Operation.job_id == screen_id)
                )
            )
            assert energies == ["18.00", "2.75", "3.20", "3.50", "None"]

    run(database_url, check)

    for job_id in body["job_ids"]:
        definition = api.get(f"/api/v1/jobs/{job_id}/definition").json()
        assert definition["backlog_status"] == "open"


def test_imported_jobs_pass_the_checks_schedule_generation_runs(api: TestClient) -> None:
    straight = upload(api, benchmark("abz5")).json()["job_ids"]
    branching = upload(api, benchmark("dafjs01")).json()["job_ids"]

    def validate(job_ids: list[str]) -> Any:
        response = api.get("/api/v1/schedules/validation", params={"job_ids": job_ids})
        assert response.status_code == 200, response.text
        return response.json()

    chains = validate(straight)
    assert chains["issues"] == []
    assert chains["schedulable"] == {"resched": True, "exact": True}

    assembly = validate(branching)
    assert assembly["issues"] == []
    assert assembly["schedulable"] == {"resched": False, "exact": True}


def test_the_job_builder_can_edit_an_imported_job(api: TestClient) -> None:
    def listed_out_of_order(document: dict[str, Any]) -> None:
        # "Inspect" waits on everything yet comes first: positions must follow precedence anyway.
        door = document["jobs"][2]["operations"]
        door.insert(0, door.pop())

    screen_id, _, door_id = upload(api, edited_example(listed_out_of_order)).json()["job_ids"]

    def resave(job_id: str, reorder: Callable[[list[Document]], list[Document]]) -> Response:
        definition = api.get(f"/api/v1/jobs/{job_id}/definition").json()
        operations = [
            {
                "id": operation["id"],
                "name": operation["name"],
                "routes": [
                    {
                        "machine_id": route["machine_id"],
                        "duration_minutes": route["duration_minutes"],
                        "energy": route["energy"],
                    }
                    for route in operation["routes"]
                ],
            }
            for operation in definition["operations"]
        ]
        return api.put(
            f"/api/v1/jobs/{job_id}/definition",
            json={
                "name": definition["name"],
                "priority": definition["priority"],
                "operations": reorder(operations),
            },
        )

    # A list-order job is the builder's own kind of chain, so it can even be reordered.
    swapped = resave(screen_id, lambda ops: [ops[0], ops[2], ops[1], ops[3]])
    assert swapped.status_code == 200, swapped.text
    assert [operation["name"] for operation in swapped.json()["operations"]] == [
        "Cut",
        "Temper",
        "Polish edges",
        "Inspect",
    ]
    # Stated precedence is numbered in an order it allows, so saving it as it stands is no cycle.
    kept = resave(door_id, lambda ops: ops)
    assert kept.status_code == 200, kept.text
    assert [operation["name"] for operation in kept.json()["operations"]] == [
        "Cut outer pane",
        "Cut inner pane",
        "Laminate",
        "Inspect",
    ]


def test_a_dry_run_reports_exactly_what_the_import_then_does_and_keeps_nothing(
    api: TestClient, database_url: str
) -> None:
    before = counts(database_url)

    preview = upload(api, EXAMPLE, dry_run=True)

    assert preview.status_code == 200, preview.text
    assert counts(database_url) == before
    imported = upload(api, EXAMPLE)
    assert imported.status_code == 201
    assert preview.json()["summary"] == imported.json()["summary"]
    assert preview.json()["warnings"] == imported.json()["warnings"]
    assert preview.json()["job_ids"] == []
    assert counts(database_url)["jobs"] == before["jobs"] + 3


def test_a_file_with_any_problem_writes_nothing_and_lists_every_problem(
    api: TestClient, database_url: str
) -> None:
    def break_two_things(document: dict[str, Any]) -> None:
        document["jobs"][0]["operations"][0]["routes"][0]["machine"] = "Cuting Table 1"
        document["jobs"][1]["operations"][1]["routes"][0]["duration"] = 0

    before = counts(database_url)

    response = upload(api, edited_example(break_two_things))

    assert response.status_code == 422, response.text
    assert sorted((item["code"], item["location"]) for item in response.json()["issues"]) == [
        ("invalid_value", "jobs[1].operations[1].routes[0].duration"),
        ("unknown_machine", "jobs[0].operations[0].routes[0]"),
    ]
    assert counts(database_url) == before


def test_importing_a_benchmark_again_reuses_its_machines_and_adds_new_jobs(
    api: TestClient, database_url: str
) -> None:
    first = upload(api, benchmark("abz5")).json()
    second = upload(api, benchmark("abz5")).json()

    assert len(first["summary"]["machines_created"]) == 10
    assert second["summary"]["machines_created"] == []
    assert second["summary"]["machines_reused"] == first["summary"]["machines_created"]
    assert set(first["job_ids"]).isdisjoint(second["job_ids"])
    assert counts(database_url)["machines"] == 10
    assert counts(database_url)["jobs"] == 20


def test_a_route_to_an_inactive_machine_is_refused(api: TestClient, database_url: str) -> None:
    add_machine(database_url, name="Old Saw", active=False)
    document = {
        "format": "floorsync",
        "version": 1,
        "jobs": [
            {
                "name": "P",
                "operations": [{"name": "Cut", "routes": [{"machine": "Old Saw", "duration": 5}]}],
            }
        ],
    }

    response = upload(api, json.dumps(document).encode())

    assert response.status_code == 422
    assert [item["code"] for item in response.json()["issues"]] == ["inactive_machine"]


def test_two_imports_creating_the_same_machine_both_succeed_and_share_it(
    database_url: str,
) -> None:
    def a_file(job: str, *, category: str, salary: int) -> ImportPlan:
        return plan_of(
            json.dumps(
                {
                    "format": "floorsync",
                    "version": 1,
                    "machines": [{"name": "Shared Saw", "category": category, "salary": salary}],
                    "jobs": [
                        {
                            "name": job,
                            "operations": [
                                {
                                    "name": "Cut",
                                    "routes": [{"machine": "Shared Saw", "duration": 5}],
                                }
                            ],
                        }
                    ],
                }
            ).encode()
        )

    async def race(sessions: Sessions) -> tuple[ImportPlanResult, ImportPlanResult, bool]:
        async with sessions() as first, sessions() as second:
            await first.begin()
            first_result = await ImportService.import_plan(
                first, a_file("First", category="Cutting", salary=50)
            )

            async def second_import() -> ImportPlanResult:
                await second.begin()
                # Disagrees with the first file, but only learns of its machine once inserting.
                result = await ImportService.import_plan(
                    second, a_file("Second", category="Milling", salary=10)
                )
                await second.commit()
                return result

            racing = asyncio.create_task(second_import())
            await asyncio.sleep(0.5)
            # Waiting on the first transaction's uncommitted "Shared Saw", not failing on it.
            blocked = not racing.done()
            await first.commit()
            return first_result, await racing, blocked

    first, second, blocked = run(database_url, race)

    assert blocked
    assert isinstance(first, ImportApplied) and isinstance(second, ImportApplied)
    assert first.summary.machines_created == ("Shared Saw",)
    assert first.summary.categories_created == ("Cutting",)
    assert [warning.code for warning in first.warnings] == []
    # Planned as new, but made by the first import by the time it was inserted: reused, and said so.
    assert second.summary.machines_created == ()
    assert second.summary.machines_reused == ("Shared Saw",)
    # Its own category was only for the machine it ended up not creating, so it is not kept.
    assert second.summary.categories_created == ()
    (differs,) = second.warnings
    assert (differs.code, differs.location) == ("machine_differs", "machines[0]")
    assert "'Cutting'" in differs.message and "salary 50.00" in differs.message

    async def check(sessions: Sessions) -> None:
        async with transaction(sessions) as db:
            shared = await db.scalar(select(Machine))
            assert shared is not None and shared.salary == Decimal("50.00")
            assert await db.scalar(select(func.count()).select_from(Machine)) == 1
            assert list(await db.scalars(select(Category.name))) == ["Cutting"]
            assert await db.scalar(select(Category.id)) == shared.category_id
            machines = await db.scalars(select(Compatibility.machine_id).distinct())
            assert len(list(machines)) == 1

    run(database_url, check)


def test_the_largest_committed_benchmark_imports_in_one_request(
    api: TestClient, database_url: str
) -> None:
    response = upload(api, benchmark("behnke58"))

    assert response.status_code == 201, response.text
    assert response.json()["summary"]["routes"] == 9748
    assert counts(database_url)["compatibilities"] == 9748


def test_a_file_over_the_request_size_limit_is_refused(api: TestClient) -> None:
    response = upload(api, b" " * 1_048_577)

    assert response.status_code == 413
    assert response.json()["type"] == "urn:floorsync:problem:request-body-too-large"
