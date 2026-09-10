import json
from pathlib import Path
from typing import Any

import pytest

from floorsync_common.seed.flexible import (
    available_flexible_instances,
    is_flexible_payload,
    load_flexible_instance,
    parse_flexible_instance,
)
from floorsync_common.seed.instances import InstanceError
from floorsync_common.seed.solutions import (
    SolutionError,
    find_solution,
    parse_solution,
    validate_flexible_against,
)


def make_payload(**overrides: Any) -> dict[str, Any]:
    """Two jobs of two operations each; every operation can run on either machine."""

    payload: dict[str, Any] = {
        "instance": "test01",
        "family": "test",
        "operations": [
            {"operation": 0, "option": 0, "machine": 0, "duration": 5},
            {"operation": 0, "option": 1, "machine": 1, "duration": 8},
            {"operation": 1, "option": 0, "machine": 0, "duration": 3},
            {"operation": 1, "option": 1, "machine": 1, "duration": 4},
            {"operation": 2, "option": 0, "machine": 0, "duration": 6},
            {"operation": 3, "option": 0, "machine": 1, "duration": 2},
        ],
        "precedences": [
            {"before": 0, "after": 1, "job": 0},
            {"before": 2, "after": 3, "job": 1},
        ],
    }
    payload.update(overrides)
    return payload


def test_parses_an_operation_with_several_candidate_machines() -> None:
    instance = parse_flexible_instance(make_payload())

    first = instance.operations_by_id[0]
    assert [(c.machine, c.duration) for c in first.candidates] == [(0, 5), (1, 8)]
    assert instance.candidate_count == 6


def test_resolves_each_operation_to_its_job_from_the_precedence_edges() -> None:
    instance = parse_flexible_instance(make_payload())

    assert {o.id: o.job for o in instance.operations} == {0: 0, 1: 0, 2: 1, 3: 1}


def test_job_labels_need_not_be_contiguous() -> None:
    """Real instances (dafjs01) label jobs sparsely, so nothing may index jobs by position."""

    payload = make_payload(
        precedences=[
            {"before": 0, "after": 1, "job": 0},
            {"before": 2, "after": 3, "job": 19},
        ]
    )

    instance = parse_flexible_instance(payload)

    assert instance.job_labels == (0, 19)
    assert [o.id for o in instance.operations_by_job[19]] == [2, 3]


def test_keeps_precedence_edges_as_given() -> None:
    instance = parse_flexible_instance(make_payload())

    assert instance.dependencies == ((0, 1), (2, 3))


def test_supports_fan_in_precedence() -> None:
    """Several operations feeding one -- an assembly step the classic format cannot express."""

    payload = make_payload(
        precedences=[
            {"before": 0, "after": 3, "job": 0},
            {"before": 1, "after": 3, "job": 0},
            {"before": 2, "after": 3, "job": 0},
        ]
    )

    instance = parse_flexible_instance(payload)

    assert sorted(before for before, after in instance.dependencies if after == 3) == [0, 1, 2]


def test_rejects_a_repeated_machine_for_one_operation() -> None:
    """Two options on the same machine would collide with UNIQUE(operation_id, machine_id)."""

    payload = make_payload(
        operations=[
            {"operation": 0, "option": 0, "machine": 0, "duration": 5},
            {"operation": 0, "option": 1, "machine": 0, "duration": 9},
            {"operation": 1, "option": 0, "machine": 1, "duration": 3},
        ],
        precedences=[{"before": 0, "after": 1, "job": 0}],
    )

    with pytest.raises(InstanceError, match="lists machine 0 more than once"):
        parse_flexible_instance(payload)


def test_rejects_an_operation_that_appears_in_no_precedence_edge() -> None:
    payload = make_payload(precedences=[{"before": 0, "after": 1, "job": 0}])

    with pytest.raises(
        InstanceError, match=r"operation\(s\) \[2, 3\] appear in no precedence edge"
    ):
        parse_flexible_instance(payload)


def test_rejects_an_operation_claimed_by_two_jobs() -> None:
    payload = make_payload(
        precedences=[
            {"before": 0, "after": 1, "job": 0},
            {"before": 1, "after": 2, "job": 7},
            {"before": 2, "after": 3, "job": 7},
        ]
    )

    with pytest.raises(InstanceError, match="appears under job 0 and job 7"):
        parse_flexible_instance(payload)


def test_rejects_a_precedence_cycle() -> None:
    payload = make_payload(
        precedences=[
            {"before": 0, "after": 1, "job": 0},
            {"before": 1, "after": 0, "job": 0},
            {"before": 2, "after": 3, "job": 1},
        ]
    )

    with pytest.raises(InstanceError, match="form a cycle"):
        parse_flexible_instance(payload)


def test_rejects_an_edge_referencing_an_unknown_operation() -> None:
    payload = make_payload(
        precedences=[
            {"before": 0, "after": 1, "job": 0},
            {"before": 2, "after": 99, "job": 1},
        ]
    )

    with pytest.raises(InstanceError, match="references operation 99"):
        parse_flexible_instance(payload)


def test_rejects_a_self_dependency() -> None:
    payload = make_payload(
        precedences=[
            {"before": 0, "after": 0, "job": 0},
            {"before": 2, "after": 3, "job": 1},
        ]
    )

    with pytest.raises(InstanceError, match="depend on itself"):
        parse_flexible_instance(payload)


def test_rejects_a_negative_duration() -> None:
    payload = make_payload(
        operations=[
            {"operation": 0, "option": 0, "machine": 0, "duration": -1},
            {"operation": 1, "option": 0, "machine": 1, "duration": 3},
        ],
        precedences=[{"before": 0, "after": 1, "job": 0}],
    )

    with pytest.raises(InstanceError, match="duration -1 is negative"):
        parse_flexible_instance(payload)


def test_distinguishes_flexible_payloads_from_classic_ones() -> None:
    assert is_flexible_payload(make_payload())
    assert not is_flexible_payload({"instance": "ft06", "jobs": 6, "machines": 6, "data": []})


def test_load_flexible_instance_reads_a_file(tmp_path: Path) -> None:
    (tmp_path / "test01.json").write_text(json.dumps(make_payload()))

    assert load_flexible_instance("test01", tmp_path).name == "test01"


def test_unknown_flexible_instance_names_what_is_available(tmp_path: Path) -> None:
    (tmp_path / "present.json").write_text(json.dumps(make_payload()))

    with pytest.raises(InstanceError, match="unknown flexible instance 'absent'"):
        load_flexible_instance("absent", tmp_path)


def make_flexible_solution(**overrides: Any) -> dict[str, Any]:
    """Operations 0 and 2 on machine 0, operations 1 and 3 on machine 1."""

    payload: dict[str, Any] = {
        "instance": "test01",
        "makespan": 11,
        "solver": "test-solver",
        "machine_0": [0, 2],
        "machine_1": [1, 3],
    }
    payload.update(overrides)
    return payload


def test_accepts_a_solution_placing_every_operation_on_a_capable_machine() -> None:
    validate_flexible_against(
        parse_solution(make_flexible_solution()), parse_flexible_instance(make_payload())
    )


def test_rejects_a_solution_leaving_an_operation_unscheduled() -> None:
    solution = parse_solution(make_flexible_solution(machine_1=[1]))

    with pytest.raises(SolutionError, match=r"does not schedule operation\(s\) \[3\]"):
        validate_flexible_against(solution, parse_flexible_instance(make_payload()))


def test_rejects_a_solution_placing_one_operation_twice() -> None:
    solution = parse_solution(make_flexible_solution(machine_1=[1, 3, 0]))

    with pytest.raises(SolutionError, match="operation 0 is placed on machines"):
        validate_flexible_against(solution, parse_flexible_instance(make_payload()))


def test_rejects_a_solution_using_a_machine_the_operation_cannot_run_on() -> None:
    """Operation 2 only lists machine 0, so placing it on machine 1 is not a valid choice."""

    solution = parse_solution(make_flexible_solution(machine_0=[0], machine_1=[1, 3, 2]))

    with pytest.raises(SolutionError, match=r"operation 2 is placed on machine 1"):
        validate_flexible_against(solution, parse_flexible_instance(make_payload()))


def test_rejects_a_solution_for_a_different_instance() -> None:
    solution = parse_solution(make_flexible_solution(instance="other"))

    with pytest.raises(SolutionError, match="solution is for 'other'"):
        validate_flexible_against(solution, parse_flexible_instance(make_payload()))


def test_committed_flexible_instances_all_parse_and_their_solutions_match() -> None:
    """The vendored files are data, not code, so verify rather than assume."""

    names = available_flexible_instances()
    assert names, "no flexible instance files committed"

    for name in names:
        instance = load_flexible_instance(name)
        assert instance.operations, f"{name} parsed with no operations"
        assert instance.candidate_count >= len(instance.operations)

        solution = find_solution(name)
        if solution is not None:
            validate_flexible_against(solution, instance)
