import json
from pathlib import Path
from typing import Any

import pytest

from floorsync_common.seed.instances import (
    DEFAULT_INSTANCE_DIRECTORY,
    InstanceError,
    available_instances,
    load_instance,
    parse_instance,
)


def make_payload(**overrides: Any) -> dict[str, Any]:
    """A two-job, two-machine instance; each test overrides only what it is about."""

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


def test_parses_declared_totals_and_operations() -> None:
    instance = parse_instance(make_payload())

    assert instance.name == "test01"
    assert instance.family == "test"
    assert instance.job_count == 2
    assert instance.machine_count == 2
    assert len(instance.operations) == 3


def test_groups_operations_by_job_in_execution_order() -> None:
    shuffled = make_payload(
        data=[
            {"job": 0, "operation": 1, "machine": 1, "duration": 7},
            {"job": 1, "operation": 0, "machine": 1, "duration": 3},
            {"job": 0, "operation": 0, "machine": 0, "duration": 5},
        ]
    )

    grouped = parse_instance(shuffled).operations_by_job

    assert [operation.index for operation in grouped[0]] == [0, 1]
    assert [operation.machine for operation in grouped[0]] == [0, 1]
    assert [operation.index for operation in grouped[1]] == [0]


def test_dependency_count_is_one_edge_between_consecutive_operations() -> None:
    # Job 0 has two operations (one edge); job 1 has a single operation (no edge).
    assert parse_instance(make_payload()).dependency_count == 1


def test_declared_job_with_no_operations_still_counts() -> None:
    """An instance may declare more jobs than its data uses; the declaration wins."""

    instance = parse_instance(make_payload(jobs=3))

    assert instance.job_count == 3
    assert instance.operations_by_job[2] == ()
    assert instance.dependency_count == 1


@pytest.mark.parametrize(
    ("overrides", "expected_message"),
    [
        ({"instance": ""}, "missing or empty 'instance'"),
        ({"jobs": 0}, "'jobs' must be a positive integer"),
        ({"machines": "two"}, "'machines' must be a positive integer"),
        ({"data": []}, "'data' is empty"),
        ({"data": {}}, "'data' must be a list of operations"),
    ],
)
def test_rejects_malformed_headers(overrides: dict[str, Any], expected_message: str) -> None:
    with pytest.raises(InstanceError, match=expected_message):
        parse_instance(make_payload(**overrides))


def test_rejects_job_index_outside_declared_count() -> None:
    payload = make_payload(data=[{"job": 9, "operation": 0, "machine": 0, "duration": 1}])

    with pytest.raises(InstanceError, match="job 9 is outside the declared 2 jobs"):
        parse_instance(payload)


def test_rejects_machine_index_outside_declared_count() -> None:
    payload = make_payload(data=[{"job": 0, "operation": 0, "machine": 5, "duration": 1}])

    with pytest.raises(InstanceError, match="machine 5 is outside the declared 2 machines"):
        parse_instance(payload)


def test_rejects_negative_duration() -> None:
    payload = make_payload(data=[{"job": 0, "operation": 0, "machine": 0, "duration": -1}])

    with pytest.raises(InstanceError, match="duration -1 is negative"):
        parse_instance(payload)


def test_rejects_non_integer_field() -> None:
    payload = make_payload(data=[{"job": 0, "operation": 0, "machine": 0, "duration": "5"}])

    with pytest.raises(InstanceError, match="'duration' must be an integer"):
        parse_instance(payload)


def test_rejects_repeated_operation_index() -> None:
    """A repeat makes the job's order ambiguous, so it cannot be turned into a dependency chain."""

    payload = make_payload(
        data=[
            {"job": 0, "operation": 0, "machine": 0, "duration": 1},
            {"job": 0, "operation": 0, "machine": 1, "duration": 2},
        ]
    )

    with pytest.raises(InstanceError, match=r"job 0 repeats operation index \[0\]"):
        parse_instance(payload)


def test_rejects_gap_in_operation_indices() -> None:
    payload = make_payload(
        data=[
            {"job": 0, "operation": 0, "machine": 0, "duration": 1},
            {"job": 0, "operation": 2, "machine": 1, "duration": 2},
        ]
    )

    with pytest.raises(InstanceError, match="operation indices are not contiguous from 0"):
        parse_instance(payload)


def test_load_instance_reads_a_file(tmp_path: Path) -> None:
    (tmp_path / "test01.json").write_text(json.dumps(make_payload()))

    assert load_instance("test01", tmp_path).name == "test01"


def test_unknown_instance_names_what_is_available(tmp_path: Path) -> None:
    (tmp_path / "present.json").write_text(json.dumps(make_payload()))

    with pytest.raises(InstanceError, match=r"unknown instance 'absent' \(available: present\)"):
        load_instance("absent", tmp_path)


def test_invalid_json_is_reported_as_such(tmp_path: Path) -> None:
    (tmp_path / "broken.json").write_text("{not json")

    with pytest.raises(InstanceError, match=r"broken\.json is not valid JSON"):
        load_instance("broken", tmp_path)


def test_available_instances_is_empty_when_the_directory_is_missing(tmp_path: Path) -> None:
    assert available_instances(tmp_path / "absent") == []


def test_committed_instances_all_parse() -> None:
    """The vendored files are data, not code, so verify they load rather than assuming they do."""

    names = available_instances()
    assert names, f"no instance files committed in {DEFAULT_INSTANCE_DIRECTORY}"

    for name in names:
        instance = load_instance(name)
        assert instance.operations, f"{name} parsed with no operations"
        assert instance.dependency_count == len(instance.operations) - sum(
            1 for operations in instance.operations_by_job.values() if operations
        ), f"{name} dependency chain does not span its operations"
