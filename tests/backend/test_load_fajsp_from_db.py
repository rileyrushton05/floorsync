"""Coverage for `load_fajsp_from_db`'s index-juggling.

`exact_solver_queries` deliberately returns plain tuples rather than ORM rows so this parsing step
can be tested without a database session (see that module's docstring): the four query functions
are monkeypatched here with canned rows, and the assertions are on how `load_fajsp_from_db` turns
those rows into the solver's op_list -- machine-index mapping and precedence edges translated into
op_list positions, including a fan-in edge and a cross-job edge.
"""

from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from floorsync_common.scheduling import load_data_from_db
from floorsync_common.scheduling.load_data_from_db import load_fajsp_from_db


def _patch_queries(
    monkeypatch: pytest.MonkeyPatch,
    *,
    machines: list[tuple[UUID, str, Decimal | None]],
    operations: list[tuple[UUID, UUID, int]],
    routes: list[tuple[UUID, UUID, int, Decimal | None]],
    precedences: list[tuple[UUID, UUID]],
) -> None:
    monkeypatch.setattr(load_data_from_db, "load_active_machines", lambda _db: machines)
    monkeypatch.setattr(load_data_from_db, "load_operations", lambda _db: operations)
    monkeypatch.setattr(load_data_from_db, "load_routes", lambda _db: routes)
    monkeypatch.setattr(load_data_from_db, "load_precedences", lambda _db: precedences)


def test_load_fajsp_from_db_maps_machine_indices_and_fan_in_precedence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    machine_1, machine_2 = uuid4(), uuid4()
    job_a, job_b = uuid4(), uuid4()
    op_a1, op_a2, op_b1, op_b2 = uuid4(), uuid4(), uuid4(), uuid4()

    _patch_queries(
        monkeypatch,
        machines=[
            (machine_1, "M1", Decimal("1.00")),
            (machine_2, "M2", Decimal("2.00")),
        ],
        operations=[
            (op_a1, job_a, 1),
            (op_a2, job_a, 2),
            (op_b1, job_b, 1),
            (op_b2, job_b, 2),
        ],
        routes=[
            (op_a1, machine_1, 5, Decimal("1.0")),
            (op_a2, machine_2, 3, None),
            (op_b1, machine_1, 4, Decimal("2.0")),
            (op_b1, machine_2, 6, Decimal("3.0")),
            (op_b2, machine_2, 2, None),
        ],
        # op_b2 fans in from two predecessors: one in its own job, one cross-job.
        precedences=[(op_a1, op_a2), (op_b1, op_b2), (op_a2, op_b2)],
    )

    jobs, machines_range, operations, eligible_by_op, op_list, machine_meta = load_fajsp_from_db(
        object()  # type: ignore[arg-type]
    )

    assert jobs == [0, 1]
    assert list(machines_range) == [0, 1]
    assert list(operations) == [0, 1, 2, 3]
    assert machine_meta == [(machine_1, Decimal("1.00")), (machine_2, Decimal("2.00"))]

    by_id = {record["op_id"]: record for record in op_list}
    index_of = {record["op_id"]: index for index, record in enumerate(op_list)}

    # each job's own operations keep the builder's position and share one job index
    assert by_id[op_a1]["pos"] == 0
    assert by_id[op_a2]["pos"] == 1
    assert by_id[op_a1]["job"] == by_id[op_a2]["job"]
    assert by_id[op_b1]["job"] == by_id[op_b2]["job"]
    assert by_id[op_a1]["job"] != by_id[op_b1]["job"]

    # machine indices in `options` are positions into `machine_meta`, not raw UUIDs
    assert by_id[op_a1]["options"] == [(5, 0)]
    assert set(by_id[op_b1]["options"]) == {(4, 0), (6, 1)}
    assert set(eligible_by_op[index_of[op_b1]]) == {0, 1}

    # energy is keyed by that same machine index
    assert by_id[op_a1]["energy_by_machine"] == {0: Decimal("1.0")}
    assert by_id[op_a2]["energy_by_machine"] == {1: None}
    assert by_id[op_b1]["energy_by_machine"] == {0: Decimal("2.0"), 1: Decimal("3.0")}

    # precedence edges are translated from raw operation ids to op_list positions
    assert by_id[op_a2]["pre"] == [index_of[op_a1]]
    assert by_id[op_a1]["post"] == [index_of[op_a2]]

    # op_b2 fans in from both predecessors, and each feeds it via `post`
    assert set(by_id[op_b2]["pre"]) == {index_of[op_b1], index_of[op_a2]}
    assert index_of[op_b2] in by_id[op_b1]["post"]
    assert index_of[op_b2] in by_id[op_a2]["post"]


def test_load_fajsp_from_db_rejects_an_operation_with_no_active_machine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A machine deactivated after its routes were written leaves an operation unschedulable."""

    machine = uuid4()
    job = uuid4()
    op_with_route, op_without_route = uuid4(), uuid4()

    _patch_queries(
        monkeypatch,
        machines=[(machine, "M1", Decimal("1.00"))],
        operations=[(op_with_route, job, 1), (op_without_route, job, 2)],
        routes=[(op_with_route, machine, 5, None)],
        precedences=[(op_with_route, op_without_route)],
    )

    with pytest.raises(ValueError, match=str(op_without_route)):
        load_fajsp_from_db(object())  # type: ignore[arg-type]
