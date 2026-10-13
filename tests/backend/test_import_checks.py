"""What an import plan says, checked against itself (#297): values and precedence.

Pure: no database. Plans are built by reading small FloorSync documents, the way an upload is.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

import pytest

from floorsync_common.imports.plan import ImportPlan
from floorsync_common.imports.results import PlanRead
from floorsync_common.imports.service import ImportService
from floorsync_common.imports.validation import ImportValidationService
from floorsync_common.operations.graph import branching_operations

check_plan = ImportValidationService.check_plan
plan_warnings = ImportValidationService.plan_warnings
precedence_edges = ImportValidationService.precedence_edges


def plan_of(*jobs: dict[str, Any], machines: list[dict[str, Any]] | None = None) -> ImportPlan:
    document: dict[str, Any] = {"format": "floorsync", "version": 1, "jobs": list(jobs)}
    if machines is not None:
        document["machines"] = machines
    result = ImportService.Parsing.read_file(json.dumps(document).encode())
    assert isinstance(result, PlanRead), result
    return result.plan


def operation(name: str, *after: str, duration: int = 5, machine: str = "Saw") -> dict[str, Any]:
    return {
        "name": name,
        "routes": [{"machine": machine, "duration": duration}],
        "after": list(after),
    }


def chain(*names: str) -> list[dict[str, Any]]:
    return [{"name": name, "routes": [{"machine": "Saw", "duration": 5}]} for name in names]


def problems(plan: ImportPlan) -> set[tuple[str, str | None]]:
    return {(issue.code, issue.location) for issue in check_plan(plan)}


def test_a_coherent_plan_has_no_problems() -> None:
    plan = plan_of(
        {
            "name": "Door",
            "operations": [operation("A"), operation("B", "A"), operation("C", "A", "B")],
        },
        {"name": "Panel", "operations": chain("Cut", "Polish")},
        machines=[{"name": "Saw", "salary": 12.5}],
    )

    assert check_plan(plan) == ()


@pytest.mark.parametrize("duration", [0, -5, 2_147_483_648])
def test_a_duration_outside_what_the_column_holds_is_refused(duration: int) -> None:
    plan = plan_of({"name": "P", "operations": [operation("A", duration=duration)]})

    assert problems(plan) == {("invalid_value", "jobs[0].operations[0].routes[0].duration")}


@pytest.mark.parametrize("energy", ["-0.01", "0.001", "100000000", "1E+400", "1E-400"])
def test_an_energy_figure_the_column_cannot_hold_exactly_is_refused(energy: str) -> None:
    raw = (
        '{"format": "floorsync", "version": 1, "jobs": [{"name": "P", "operations": [{"name": "A", '
        f'"routes": [{{"machine": "Saw", "duration": 1, "energy": {energy}}}]}}]}}]}}'
    ).encode()
    result = ImportService.Parsing.read_file(raw)
    assert isinstance(result, PlanRead)

    assert problems(result.plan) == {("invalid_value", "jobs[0].operations[0].routes[0].energy")}


def test_salary_has_the_same_bounds_as_energy() -> None:
    plan = plan_of(
        {"name": "P", "operations": chain("A")},
        machines=[{"name": "Saw", "salary": -1}, {"name": "Lathe", "salary": 99999999.99}],
    )

    assert problems(plan) == {("invalid_value", "machines[0].salary")}


def test_a_machine_declared_twice_and_a_route_listed_twice_are_refused() -> None:
    plan = plan_of(
        {
            "name": "P",
            "operations": [
                {
                    "name": "A",
                    "routes": [
                        {"machine": "Saw", "duration": 1},
                        {"machine": "Saw", "duration": 2},
                    ],
                }
            ],
        },
        machines=[{"name": "Saw"}, {"name": "Saw"}],
    )

    assert problems(plan) == {
        ("duplicate_machine", "machines[1]"),
        ("duplicate_route", "jobs[0].operations[0].routes[1]"),
    }


def test_stated_precedence_needs_unique_operation_names_within_the_job() -> None:
    plan = plan_of(
        {"name": "P", "operations": [operation("A"), operation("A"), operation("B", "A")]},
        {"name": "Q", "operations": [*chain("A"), *chain("A")]},
    )

    # The second job states nothing, so it is a list-order chain and a repeated name is harmless.
    assert problems(plan) == {("duplicate_operation_name", "jobs[0].operations[1]")}


def test_every_bad_reference_in_an_after_list_is_named() -> None:
    plan = plan_of(
        {
            "name": "P",
            "operations": [
                operation("A", "A"),
                operation("B", "Nope", "A", "A", "C"),
                operation("C"),
            ],
        }
    )

    assert problems(plan) == {
        ("predecessor_not_earlier", "jobs[0].operations[0].after[0]"),
        ("unknown_predecessor", "jobs[0].operations[1].after[0]"),
        ("duplicate_dependency", "jobs[0].operations[1].after[2]"),
        ("predecessor_not_earlier", "jobs[0].operations[1].after[3]"),
    }


def test_a_cycle_cannot_be_written_because_an_operation_only_waits_on_earlier_ones() -> None:
    plan = plan_of(
        {
            "name": "P",
            "operations": [operation("A"), operation("B", "A", "C"), operation("C", "B")],
        }
    )

    (issue,) = check_plan(plan)
    assert (issue.code, issue.location) == (
        "predecessor_not_earlier",
        "jobs[0].operations[1].after[1]",
    )
    assert "'C', which is listed after it" in issue.message
    assert precedence_edges(plan.jobs[0]) == [(0, 1), (1, 2)]


def test_a_job_that_states_nothing_runs_in_the_order_listed() -> None:
    plan = plan_of({"name": "P", "operations": chain("Cut", "Polish", "Pack")})

    assert precedence_edges(plan.jobs[0]) == [(0, 1), (1, 2)]


def test_stated_precedence_points_from_earlier_operations_to_later_ones() -> None:
    plan = plan_of(
        {
            "name": "P",
            "operations": [
                operation("Cut"),
                operation("Label"),
                operation("Glue", "Cut"),
                operation("Pack", "Glue", "Label"),
            ],
        }
    )

    assert check_plan(plan) == ()
    assert precedence_edges(plan.jobs[0]) == [(0, 2), (2, 3), (1, 3)]


def test_only_a_branching_job_is_flagged_as_beyond_resched() -> None:
    plan = plan_of(
        {"name": "Straight", "operations": [operation("A"), operation("B", "A")]},
        {
            "name": "Fan-in",
            "operations": [operation("A"), operation("B"), operation("C", "A", "B")],
        },
        {
            "name": "Fan-out",
            "operations": [operation("A"), operation("B", "A"), operation("C", "A")],
        },
    )

    assert [(issue.code, issue.location) for issue in plan_warnings(plan)] == [
        ("resched_unsupported", "jobs[1]"),
        ("resched_unsupported", "jobs[2]"),
    ]


def test_branching_operations_finds_fan_in_and_fan_out() -> None:
    assert branching_operations([("a", "b"), ("b", "c")]) == set()
    assert branching_operations([("a", "c"), ("b", "c")]) == {"c"}
    assert branching_operations([("a", "b"), ("a", "c")]) == {"a"}


IMPORTS = Path(__file__).resolve().parents[2] / "src/backend/common/floorsync_common/imports"
PURE_MODULES = [
    "plan",
    "results",
    "validation",
    "parsing",
    "formats/floorsync",
    "formats/benchmarks",
]
DATABASE_LAYER = (
    "sqlalchemy",
    "floorsync_common.imports.persistence",
    "floorsync_common.imports.service",
)


@pytest.mark.parametrize("module", PURE_MODULES)
def test_pure_import_modules_never_reach_for_the_database(module: str) -> None:
    """Imports point down: parsing and validation must work, and be testable, with no database."""

    imported: set[str] = set()
    for node in ast.walk(ast.parse((IMPORTS / f"{module}.py").read_text())):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            imported.add(node.module)

    assert not {name for name in imported if name.startswith(DATABASE_LAYER)}
