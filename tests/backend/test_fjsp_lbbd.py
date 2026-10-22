"""The LBBD loop itself, with the CP warm start off so the master and cuts actually run.

`test_gurobi_exact_solver.py` covers `FJSP_lbbd.solve_fajsp` end to end, but on instances that
small the warm start proves the optimum before the first master solve. Optima are the published
best-known makespans for the seeded benchmarks.
"""

from collections import defaultdict
from itertools import pairwise
from uuid import UUID

from floorsync_common.scheduling.FJSP_lbbd import lbbd
from floorsync_common.scheduling.gurobi_exact_solver import OpRecord
from floorsync_common.seed.flexible import load_flexible_instance


def load_fajsp(name: str) -> tuple[list[int], range, dict[int, list[int]], list[OpRecord]]:
    """A seeded instance as (machines, operations, eligible machines, operation records)."""
    instance = load_flexible_instance(name)
    op_ids = sorted(instance.operations_by_id)
    index_of = {op_id: index for index, op_id in enumerate(op_ids)}
    machine_labels = sorted(
        {candidate.machine for op in instance.operations for candidate in op.candidates}
    )
    machine_index = {label: index for index, label in enumerate(machine_labels)}
    operation_data: list[OpRecord] = [
        {
            "op_id": UUID(int=op_id),
            "options": [
                (candidate.duration, machine_index[candidate.machine])
                for candidate in instance.operations_by_id[op_id].candidates
            ],
            "pre": [],
            "energy_by_machine": {},
        }
        for op_id in op_ids
    ]
    for before, after in instance.dependencies:
        operation_data[index_of[after]]["pre"].append(index_of[before])
    operations = range(len(operation_data))
    eligible = {i: [k for _, k in operation_data[i]["options"]] for i in operations}
    return list(range(len(machine_labels))), operations, eligible, operation_data


def _assert_feasible(result: dict, eligible: dict, operation_data: list) -> None:
    p = {(i, k): d for i, record in enumerate(operation_data) for d, k in record["options"]}
    machine_of, start = result["machine_of"], result["start"]
    by_machine = defaultdict(list)
    for i, record in enumerate(operation_data):
        k = machine_of[i]
        assert k in eligible[i]
        assert start[i] + p[i, k] <= result["makespan"]
        for a in record["pre"]:
            assert start[i] >= start[a] + p[a, machine_of[a]]
        by_machine[k].append((start[i], start[i] + p[i, k]))
    for spans in by_machine.values():
        spans.sort()
        assert all(a[1] <= b[0] for a, b in pairwise(spans))


def test_lbbd_proves_the_known_optimum_without_a_warm_start() -> None:
    for name, optimum in (("fattahi1", 66), ("kacem1", 11)):
        machines, operations, eligible, operation_data = load_fajsp(name)
        result = lbbd(operations, machines, eligible, operation_data, 30, warm_start=False)
        assert result is not None
        _assert_feasible(result, eligible, operation_data)
        assert result["optimal"] and result["makespan"] == optimum, name


def test_lbbd_cuts_keep_the_bound_valid_on_a_dag_instance() -> None:
    """dafjs01 (optimum 257) has fan-in precedences, so release times make unsafe cuts unsound."""
    machines, operations, eligible, operation_data = load_fajsp("dafjs01")
    result = lbbd(operations, machines, eligible, operation_data, 5, warm_start=False)
    assert result is not None and result["iterations"] > 1
    _assert_feasible(result, eligible, operation_data)
    assert result["lower_bound"] <= 257 <= result["makespan"]
