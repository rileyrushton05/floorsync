"""Reading an uploaded file into an import plan (#297): formats, detection and every refusal.

Pure: no database. What the plan's values mean is `test_import_checks.py`; writing it is
`tests/integration/test_data_import.py`.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from floorsync_common.imports import benchmarks
from floorsync_common.imports.checks import MAX_IMPORT_JOBS, MAX_IMPORT_MACHINES, check_plan
from floorsync_common.imports.plan import ImportPlan
from floorsync_common.imports.results import FileUnreadable, PlanRead
from floorsync_common.imports.service import ImportService

REPO = Path(__file__).resolve().parents[2]
EXAMPLE = REPO / "docs" / "examples" / "import-example.json"
SEED_DATA = REPO / "src" / "database" / "seed-data"


def plan_of(document: dict[str, Any] | bytes) -> ImportPlan:
    raw = document if isinstance(document, bytes) else json.dumps(document).encode()
    result = ImportService.read_file(raw)
    assert isinstance(result, PlanRead), result
    return result.plan


def problems_of(document: dict[str, Any] | bytes) -> set[tuple[str, str | None]]:
    raw = document if isinstance(document, bytes) else json.dumps(document).encode()
    result = ImportService.read_file(raw)
    assert isinstance(result, FileUnreadable), result
    return {(issue.code, issue.location) for issue in result.issues}


def floorsync(*jobs: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"format": "floorsync", "version": 1, "jobs": list(jobs), **extra}


def job(name: str = "Panel", **fields: Any) -> dict[str, Any]:
    return {
        "name": name,
        "operations": [{"name": "Cut", "routes": [{"machine": "Saw", "duration": 10}]}],
        **fields,
    }


def test_the_documented_example_reads_into_the_plan_it_describes() -> None:
    plan = plan_of(EXAMPLE.read_bytes())

    assert plan.format == "floorsync"
    saw = plan.machines[0]
    assert (saw.name, saw.category, saw.salary) == ("Cutting Table 1", "Cutting", Decimal("38.5"))
    assert plan.machines[-1].category is not None and plan.machines[-1].salary is None
    assert [job.priority for job in plan.jobs] == ["high", "med", "low"]

    screen, splashback, door = plan.jobs
    assert not screen.states_precedence and not splashback.states_precedence
    assert door.states_precedence
    assert door.operations[2].after == ("Cut outer pane", "Cut inner pane")
    assert door.operations[0].after == ()
    assert screen.operations[0].routes[0].energy == Decimal("3.5")
    assert screen.operations[3].routes[0].energy is None
    assert screen.operations[1].routes[0].location == "jobs[0].operations[1].routes[0]"


def test_names_are_trimmed_and_whole_decimal_durations_are_whole_numbers() -> None:
    plan = plan_of(
        floorsync(
            {
                "name": "  Panel  ",
                "operations": [
                    {"name": " Cut ", "routes": [{"machine": " Saw ", "duration": 30.0}]}
                ],
            }
        )
    )

    operation = plan.jobs[0].operations[0]
    assert (plan.jobs[0].name, operation.name, operation.routes[0].machine) == (
        "Panel",
        "Cut",
        "Saw",
    )
    assert operation.routes[0].duration == 30
    assert plan.jobs[0].priority == "med"


def test_a_byte_order_mark_is_accepted() -> None:
    raw = b"\xef\xbb\xbf" + json.dumps(floorsync(job())).encode()

    assert plan_of(raw).jobs[0].name == "Panel"


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        (b"", "empty_file"),
        (b"  \n ", "empty_file"),
        (b"\xff\xfe{", "not_utf8"),
        (b'{"format": ', "not_json"),
        (b'{"format": "floorsync", "version": NaN, "jobs": []}', "not_json"),
        (b'{"format": "floorsync", "format": "floorsync"}', "duplicate_key"),
        (b"[" * 100_000, "too_deeply_nested"),
        (b"[]", "not_an_object"),
        (b'"floorsync"', "not_an_object"),
        (b'{"jobs": [], "machines": []}', "unknown_format"),
        (b'{"format": "floorsync", "version": 2, "jobs": []}', "unsupported_version"),
        (b'{"format": "floorsync", "version": 2.0, "jobs": []}', "unsupported_version"),
        (b'{"instance": "x", "data": [], "jobs": 1, "machines": 1}', "invalid_benchmark"),
        (b'{"instance": "x", "operations": [], "precedences": []}', "invalid_benchmark"),
    ],
)
def test_a_file_that_cannot_be_read_says_why(raw: bytes, code: str) -> None:
    result = ImportService.read_file(raw)

    assert isinstance(result, FileUnreadable)
    assert [issue.code for issue in result.issues] == [code]


def test_every_shape_problem_in_a_floorsync_file_is_reported_at_once_with_its_path() -> None:
    document = floorsync(
        {"operations": [{"name": "Cut", "routes": [{"machine": "Saw", "duration": "ten"}]}]},
        {"name": "Frame", "priorty": "high", "operations": []},
        {
            "name": "Door",
            "priority": "urgent",
            "operations": [
                {"name": "Cut", "routes": []},
                {"name": "Glue", "routes": [{"machine": "Press", "duration": 5, "energy": "2"}]},
                {"name": "Pack", "routes": [{"duration": 5}], "after": "Glue"},
                {"name": "Ship", "routes": [{"machine": "Van", "duration": 5}], "after": [3]},
            ],
        },
        "not a job",
        machines=[{"name": "   "}, {"name": "Saw", "salary": True}, {"name": "Lathe\u0000"}],
    )

    assert problems_of(document) == {
        ("missing_field", "jobs[0].name"),
        ("wrong_type", "jobs[0].operations[0].routes[0].duration"),
        ("unknown_field", "jobs[1].priorty"),
        ("invalid_value", "jobs[1].operations"),
        ("invalid_value", "jobs[2].priority"),
        ("invalid_value", "jobs[2].operations[0].routes"),
        ("wrong_type", "jobs[2].operations[1].routes[0].energy"),
        ("missing_field", "jobs[2].operations[2].routes[0].machine"),
        ("wrong_type", "jobs[2].operations[2].after"),
        ("wrong_type", "jobs[2].operations[3].after[0]"),
        ("wrong_type", "jobs[3]"),
        ("invalid_value", "machines[0].name"),
        ("wrong_type", "machines[1].salary"),
        ("invalid_value", "machines[2].name"),
    }


def test_an_explicit_null_is_a_mistake_even_where_the_field_may_be_left_out() -> None:
    # Pydantic would read `null` as "not given" for an optional field; this format does not.
    document = floorsync(
        {
            "name": "Panel",
            "priority": None,
            "operations": [
                {
                    "name": "Cut",
                    "after": None,
                    "routes": [{"machine": "Saw", "duration": 10, "energy": None}],
                }
            ],
        },
        machines=[{"name": "Saw", "category": None, "salary": None}],
    )

    assert problems_of(document) == {
        ("invalid_value", "jobs[0].priority"),
        ("wrong_type", "jobs[0].operations[0].after"),
        ("wrong_type", "jobs[0].operations[0].routes[0].energy"),
        ("wrong_type", "machines[0].category"),
        ("wrong_type", "machines[0].salary"),
    }
    assert problems_of(floorsync(job(), machines=None)) == {("wrong_type", "machines")}


def test_true_and_false_are_never_numbers() -> None:
    document = {
        "format": "floorsync",
        "version": True,
        "jobs": [
            {
                "name": "Panel",
                "operations": [
                    {
                        "name": "Cut",
                        "routes": [{"machine": "Saw", "duration": True, "energy": False}],
                    }
                ],
            }
        ],
    }

    assert problems_of(document) == {
        ("wrong_type", "version"),
        ("wrong_type", "jobs[0].operations[0].routes[0].duration"),
        ("wrong_type", "jobs[0].operations[0].routes[0].energy"),
    }


def test_an_unknown_field_is_named_where_it_is() -> None:
    result = ImportService.read_file(json.dumps(floorsync(job(colour="red"))).encode())

    assert isinstance(result, FileUnreadable)
    (issue,) = result.issues
    assert (issue.code, issue.location) == ("unknown_field", "jobs[0].colour")
    assert issue.message == "'colour' is not a field here."


def test_a_floorsync_file_needs_a_version_and_at_least_one_job() -> None:
    assert problems_of({"format": "floorsync", "jobs": []}) == {
        ("missing_field", "version"),
        ("invalid_value", "jobs"),
    }


def test_a_fractional_duration_is_not_a_whole_number_of_minutes() -> None:
    document = floorsync(
        {"name": "P", "operations": [{"name": "C", "routes": [{"machine": "S", "duration": 2.5}]}]}
    )

    assert problems_of(document) == {("wrong_type", "jobs[0].operations[0].routes[0].duration")}


def test_energy_and_salary_are_read_as_exact_decimals() -> None:
    plan = plan_of(
        floorsync(
            {
                "name": "P",
                "operations": [
                    {"name": "C", "routes": [{"machine": "S", "duration": 1, "energy": 0.1}]}
                ],
            },
            machines=[{"name": "S", "salary": 19.99}],
        )
    )

    assert plan.jobs[0].operations[0].routes[0].energy == Decimal("0.1")
    assert plan.machines[0].salary == Decimal("19.99")


@pytest.mark.parametrize(
    "path",
    sorted((SEED_DATA / "jobshop").glob("*.json"))
    + sorted((SEED_DATA / "flexible-jobshop").glob("*.json")),
    ids=lambda path: path.stem,
)
def test_every_committed_benchmark_reads_with_the_seed_loaders_machine_names(path: Path) -> None:
    plan = plan_of(path.read_bytes())

    assert plan.format == ("jobshop" if path.parent.name == "jobshop" else "flexible-jobshop")
    assert plan.machines[0].name in {f"{path.stem}/M0", f"{path.stem}/M00"}
    assert all(job.name.startswith(f"{path.stem}/J") for job in plan.jobs)


def test_a_classic_benchmark_chains_each_job_in_order_and_skips_a_job_with_no_steps() -> None:
    plan = plan_of(
        {
            "instance": "tiny",
            "family": "test",
            "jobs": 3,
            "machines": 2,
            "data": [
                {"job": 0, "operation": 1, "machine": 0, "duration": 4},
                {"job": 0, "operation": 0, "machine": 1, "duration": 3},
                {"job": 2, "operation": 0, "machine": 0, "duration": 5},
            ],
        }
    )

    assert [job.name for job in plan.jobs] == ["tiny/J0", "tiny/J2"]
    first = plan.jobs[0]
    assert not first.states_precedence
    assert [operation.name for operation in first.operations] == ["Op0", "Op1"]
    assert [route.machine for operation in first.operations for route in operation.routes] == [
        "tiny/M1",
        "tiny/M0",
    ]
    assert [machine.name for machine in plan.machines] == ["tiny/M0", "tiny/M1"]


def tiny_classic(*, jobs: int = 1, machines: int = 1) -> dict[str, Any]:
    return {
        "instance": "tiny",
        "family": "test",
        "jobs": jobs,
        "machines": machines,
        "data": [{"job": 0, "operation": 0, "machine": 0, "duration": 1}],
    }


@pytest.mark.parametrize(
    ("document", "location"),
    [
        (tiny_classic(machines=MAX_IMPORT_MACHINES + 1), "machines"),
        (tiny_classic(jobs=MAX_IMPORT_JOBS + 1), "jobs"),
    ],
    ids=["machines", "jobs"],
)
def test_a_classic_benchmark_declaring_too_much_is_refused_before_it_is_expanded(
    document: dict[str, Any], location: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A few bytes can declare millions of machines or jobs; nothing count-sized may be built.
    def expanded(*_: object, **__: object) -> None:
        raise AssertionError("the declared counts were expanded before being bounded")

    monkeypatch.setattr(benchmarks, "PlannedMachine", expanded)
    monkeypatch.setattr(benchmarks, "PlannedJob", expanded)

    assert problems_of(document) == {("too_large", location)}


def test_the_size_limits_hold_for_floorsync_and_flexible_files_too() -> None:
    many_machines = floorsync(
        job(), machines=[{"name": f"M{index}"} for index in range(MAX_IMPORT_MACHINES + 1)]
    )
    many_jobs = floorsync(*(job(f"J{index}") for index in range(MAX_IMPORT_JOBS + 1)))
    flexible = {
        "instance": "wide",
        "operations": [
            *(
                {"operation": 0, "machine": machine, "duration": 1}
                for machine in range(MAX_IMPORT_MACHINES + 1)
            ),
            {"operation": 1, "machine": 0, "duration": 1},
        ],
        "precedences": [{"before": 0, "after": 1, "job": 0}],
    }

    assert problems_of(many_machines) == {("too_large", "machines")}
    assert problems_of(many_jobs) == {("too_large", "jobs")}
    assert problems_of(flexible) == {("too_large", "operations")}


def test_a_number_beyond_what_a_decimal_can_hold_is_unreadable_not_an_error() -> None:
    raw = (
        json.dumps(floorsync(job()))
        .encode()
        .replace(b'"duration": 10', b'"duration": 10, "energy": 1e999999999999999999999')
    )

    result = ImportService.read_file(raw)

    assert isinstance(result, FileUnreadable)
    assert [issue.code for issue in result.issues] == ["not_json"]


@pytest.mark.parametrize("value", [b"1e5000000", b"-1e5000000", b"1e19"])
def test_a_whole_number_too_large_for_any_field_is_refused_without_expanding_it(
    value: bytes,
) -> None:
    # `int(Decimal("1e5000000"))` builds a five-million-digit integer: minutes of CPU per upload.
    raw = json.dumps(floorsync(job())).encode().replace(b'"duration": 10', b'"duration": ' + value)

    assert problems_of(raw) == {("invalid_value", "jobs[0].operations[0].routes[0].duration")}


def test_a_flexible_benchmark_states_each_operations_predecessors() -> None:
    plan = plan_of(
        {
            "instance": "fork",
            "operations": [
                {"operation": 0, "machine": 0, "duration": 2},
                {"operation": 0, "machine": 1, "duration": 3},
                {"operation": 1, "machine": 0, "duration": 4},
                {"operation": 2, "machine": 1, "duration": 1},
            ],
            "precedences": [
                {"before": 0, "after": 2, "job": 7},
                {"before": 1, "after": 2, "job": 7},
            ],
        }
    )

    (only,) = plan.jobs
    assert only.name == "fork/J7" and only.states_precedence
    assert [operation.after for operation in only.operations] == [(), (), ("Op0", "Op1")]
    assert [route.machine for route in only.operations[0].routes] == ["fork/M0", "fork/M1"]


def test_a_flexible_benchmark_operation_waiting_on_a_later_one_is_refused() -> None:
    plan = plan_of(
        {
            "instance": "backwards",
            "operations": [
                {"operation": 0, "machine": 0, "duration": 2},
                {"operation": 1, "machine": 0, "duration": 4},
            ],
            "precedences": [{"before": 1, "after": 0, "job": 0}],
        }
    )

    assert [issue.code for issue in check_plan(plan)] == ["predecessor_not_earlier"]
