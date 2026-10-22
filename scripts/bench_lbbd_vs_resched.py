"""Benchmark ReSched against CP-LBBD on Brandimarte mk01-mk10 and three Hurink instances.

    GRB_LICENSE_FILE=$PWD/gurobi.lic uv run --extra resched \
        python scripts/bench_lbbd_vs_resched.py [--time-limit 120]

Writes evidence/benchmarks/results_lbbd_vs_resched.csv in the results_for_solver.csv layout, row by
row, so an interrupted run keeps what it finished. BKS is the ub from ReSched's
BenchDataSolution.csv, overridden by the newer bks in results_for_solver.csv where it has one.
"""

import argparse
import csv
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src/backend/common"))

import gurobipy as gp  # noqa: E402

from floorsync_common.scheduling.contracts import (  # noqa: E402
    DependencySpec,
    MachineSpec,
    OperationSpec,
    RouteSpec,
    ScheduleGenerated,
    SchedulingInput,
)
from floorsync_common.scheduling.FJSP_lbbd import TIME_LIMIT_SECONDS, lbbd  # noqa: E402
from floorsync_common.scheduling.gurobi_exact_solver import adapt_scheduling_input  # noqa: E402
from floorsync_common.scheduling.resched import ReSchedEngine  # noqa: E402

TNNLS = ROOT / "src/backend/third_party/ReSched/data/FJSP/TNNLS"
BENCH = ROOT / "evidence/benchmarks"
OLD_RESULTS = BENCH / "results_for_solver.csv"
HURINK = ("la24_vdata", "la26_edata", "la28_edata")
FIELDS = [
    "run_at",
    "instance",
    "method",
    "makespan",
    "lower_bound",
    "seconds",
    "status",
    "bks",
    "gap_to_bks",
]


def parse_fjs(path: Path) -> SchedulingInput:
    """Standard .fjs text: header, then per job `n_ops (k (machine duration)*k)*n_ops`."""
    lines = [line.split() for line in path.read_text().splitlines() if line.strip()]
    candidates: list[list[tuple[int, int]]] = []  # per operation: (machine, duration) options
    edges: list[tuple[int, int]] = []  # (before, after) operation indexes
    for row in lines[1 : int(lines[0][0]) + 1]:
        numbers = list(map(int, row))
        position = 1
        for step in range(numbers[0]):
            k = numbers[position]
            pairs = numbers[position + 1 : position + 1 + 2 * k]
            position += 1 + 2 * k
            if step:
                edges.append((len(candidates) - 1, len(candidates)))
            # machines are 1-indexed in the file
            candidates.append([(pairs[j] - 1, pairs[j + 1]) for j in range(0, 2 * k, 2)])
    machines = sorted({machine for options in candidates for machine, _ in options})
    return SchedulingInput(
        starts_at=datetime(2026, 1, 1, tzinfo=UTC),
        machines=tuple(MachineSpec(UUID(int=m), True, None) for m in machines),
        operations=tuple(OperationSpec(UUID(int=i), f"op{i}") for i in range(len(candidates))),
        routes=tuple(
            RouteSpec(UUID(int=i), UUID(int=m), duration, None)
            for i, options in enumerate(candidates)
            for m, duration in options
        ),
        dependencies=tuple(DependencySpec(UUID(int=a), UUID(int=b)) for a, b in edges),
    )


def instances():
    """Yield (name, .fjs path, bks)."""
    with open(TNNLS / "BenchData/BenchDataSolution.csv", encoding="utf-8-sig") as file:
        rows = list(csv.DictReader(file))
    with open(OLD_RESULTS) as file:
        newer_bks = {row["instance"]: int(row["bks"]) for row in csv.DictReader(file)}
    for row in rows:
        bench, data = (
            row["benchname"],
            row["dataname"],
        )  # "Brandimarte","mk1" / "Hurink_vdata","la24"
        if bench == "Brandimarte":
            name = f"mk{int(data[2:]):02d}"
        else:
            name = f"{data}_{bench.split('_')[1]}"
            if name not in HURINK:
                continue
        yield (
            name,
            TNNLS / "BenchData" / bench / f"{row['filename']}.fjs",
            newer_bks.get(name, int(row["ub"])),
        )


def run_resched(problem: SchedulingInput) -> dict:
    started = time.perf_counter()
    try:
        result = ReSchedEngine.generate(problem)
    except Exception as error:  # the learned model itself can crash on shapes it never trained on
        return {"seconds": time.perf_counter() - started, "status": f"crashed: {error!r}"}
    seconds = time.perf_counter() - started
    if not isinstance(result, ScheduleGenerated):
        return {"seconds": seconds, "status": type(result).__name__}
    return {
        "makespan": result.plan.metrics.makespan_minutes,
        "seconds": seconds,
        "status": "heuristic",
    }


def run_lbbd(problem, time_limit: float) -> dict:
    operations, eligible, op_list, machine_meta = adapt_scheduling_input(problem)
    started = time.perf_counter()
    result = lbbd(operations, range(len(machine_meta)), eligible, op_list, time_limit=time_limit)
    seconds = time.perf_counter() - started
    if result is None:
        return {"seconds": seconds, "status": "no solution"}
    makespan, lb = result["makespan"], result["lower_bound"]
    status = "optimal" if result["optimal"] else f"time limit, gap {(makespan - lb) / makespan:.1%}"
    return {"makespan": makespan, "lower_bound": lb, "seconds": seconds, "status": status}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--time-limit", type=float, default=TIME_LIMIT_SECONDS, help="LBBD seconds")
    parser.add_argument("--out", default=BENCH / "results_lbbd_vs_resched.csv")
    args = parser.parse_args()

    gp.setParam("OutputFlag", 0)
    todo = list(instances())
    run_resched(parse_fjs(todo[0][1]))  # warm-up: the first call pays the torch import

    with open(args.out, "w", newline="") as file:
        writer = csv.DictWriter(file, FIELDS)
        writer.writeheader()
        for name, path, bks in todo:
            problem = parse_fjs(path)
            for method in ("resched", "cp-lbbd"):
                run_at = datetime.now().isoformat(timespec="seconds")
                if method == "resched":
                    result = run_resched(problem)
                else:
                    result = run_lbbd(problem, args.time_limit)
                makespan = result.get("makespan")
                row = (
                    {
                        "run_at": run_at,
                        "instance": name,
                        "method": method,
                        "bks": bks,
                        "gap_to_bks": f"{(makespan - bks) / bks:.2%}" if makespan else None,
                    }
                    | result
                    | {"seconds": f"{result['seconds']:.3f}"}
                )
                writer.writerow(row)
                file.flush()
                print(
                    f"{name:>11} {method:>8}  Cmax={makespan}  bks={bks}  {row['seconds']}s"
                    f"  {row['status']}",
                    flush=True,
                )


if __name__ == "__main__":
    main()
