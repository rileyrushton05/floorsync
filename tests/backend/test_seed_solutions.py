import json
from pathlib import Path
from typing import Any

import pytest

from floorsync_common.seed.instances import load_instance, parse_instance
from floorsync_common.seed.solutions import (
    SolutionError,
    available_solutions,
    find_solution,
    parse_solution,
    validate_against,
)


def make_solution(**overrides: Any) -> dict[str, Any]:
    """A solution for the two-job, two-machine instance below."""

    payload: dict[str, Any] = {
        "instance": "test01",
        "makespan": 15,
        "solver": "test-solver",
        "date": "2026-09-06",
        "machine_0": [0],
        "machine_1": [1, 0],
    }
    payload.update(overrides)
    return payload


def make_instance_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "instance": "test01",
        "family": "test",
        "jobs": 2,
        "machines": 2,
        "data": [
            {"job": 0, "operation": 0, "machine": 0, "duration": 5},
            {"job": 0, "operation": 1, "machine": 1, "duration": 7},
            {"job": 1, "operation": 0, "machine": 1, "duration": 3},
        ],
    }
    payload.update(overrides)
    return payload


def test_parses_machine_sequences() -> None:
    solution = parse_solution(make_solution())

    assert solution.instance == "test01"
    assert solution.solver == "test-solver"
    assert solution.makespan == 15
    assert solution.machine_sequences == {0: (0,), 1: (1, 0)}


def test_queue_edge_count_is_one_per_consecutive_pair() -> None:
    # machine_0 has one job (no edge); machine_1 has two (one edge).
    assert parse_solution(make_solution()).queue_edge_count == 1


@pytest.mark.parametrize(
    ("overrides", "expected_message"),
    [
        ({"instance": ""}, "missing an 'instance' name"),
        ({"solver": ""}, "missing a 'solver' name"),
        ({"makespan": "fast"}, "'makespan' must be an integer"),
    ],
)
def test_rejects_malformed_headers(overrides: dict[str, Any], expected_message: str) -> None:
    with pytest.raises(SolutionError, match=expected_message):
        parse_solution(make_solution(**overrides))


def test_rejects_non_integer_job_index() -> None:
    with pytest.raises(SolutionError, match=r"machine_0\[0\] must be an integer job index"):
        parse_solution(make_solution(machine_0=["first"]))


def test_rejects_solution_with_no_machine_sequences() -> None:
    payload = {"instance": "test01", "solver": "test-solver", "makespan": 1}

    with pytest.raises(SolutionError, match="no 'machine_N' sequences"):
        parse_solution(payload)


def test_accepts_a_solution_that_matches_its_instance() -> None:
    validate_against(parse_solution(make_solution()), parse_instance(make_instance_payload()))


def test_rejects_a_solution_for_a_different_instance() -> None:
    solution = parse_solution(make_solution(instance="other"))

    with pytest.raises(SolutionError, match="solution is for 'other' but the instance is 'test01'"):
        validate_against(solution, parse_instance(make_instance_payload()))


def test_rejects_a_sequence_that_does_not_match_the_jobs_routed_to_the_machine() -> None:
    solution = parse_solution(make_solution(machine_1=[1]))

    with pytest.raises(SolutionError, match=r"machine 1 sequence \[1\] does not match"):
        validate_against(solution, parse_instance(make_instance_payload()))


def test_rejects_a_missing_machine_sequence() -> None:
    payload = make_solution()
    del payload["machine_0"]

    with pytest.raises(SolutionError, match=r"no sequence for machine\(s\) \[0\]"):
        validate_against(parse_solution(payload), parse_instance(make_instance_payload()))


def test_rejects_a_reentrant_instance() -> None:
    """A sequence names jobs, so it cannot say which of a job's two machine visits runs first."""

    reentrant = make_instance_payload(
        data=[
            {"job": 0, "operation": 0, "machine": 0, "duration": 5},
            {"job": 0, "operation": 1, "machine": 0, "duration": 7},
        ]
    )

    with pytest.raises(SolutionError, match="visited more than once by job"):
        validate_against(parse_solution(make_solution(machine_0=[0])), parse_instance(reentrant))


def test_find_solution_locates_by_instance_name(tmp_path: Path) -> None:
    (tmp_path / "solutions_test.json").write_text(json.dumps([make_solution()]))

    found = find_solution("test01", tmp_path)

    assert found is not None
    assert found.solver == "test-solver"


def test_find_solution_returns_none_when_unsolved(tmp_path: Path) -> None:
    (tmp_path / "solutions_test.json").write_text(json.dumps([make_solution()]))

    assert find_solution("absent", tmp_path) is None
    assert find_solution("test01", tmp_path / "missing") is None


def test_find_solution_rejects_a_non_array_file(tmp_path: Path) -> None:
    (tmp_path / "solutions_test.json").write_text(json.dumps(make_solution()))

    with pytest.raises(SolutionError, match="must contain a JSON array"):
        find_solution("test01", tmp_path)


def test_available_solutions_lists_solved_instances(tmp_path: Path) -> None:
    (tmp_path / "a.json").write_text(json.dumps([make_solution(instance="beta")]))
    (tmp_path / "b.json").write_text(json.dumps([make_solution(instance="alpha")]))

    assert available_solutions(tmp_path) == ["alpha", "beta"]


def test_committed_solutions_match_their_committed_instances() -> None:
    """Vendored solutions are data; verify they actually describe the vendored instances."""

    solved = available_solutions()
    assert solved, "no solution files committed"

    for name in solved:
        solution = find_solution(name)
        assert solution is not None
        validate_against(solution, load_instance(name))
