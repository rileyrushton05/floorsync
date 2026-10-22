"""Benchmark ReSched against CP-LBBD on Brandimarte mk01-mk10 and three Hurink instances.

    GRB_LICENSE_FILE=$PWD/gurobi.lic uv run --extra resched \
        python scripts/bench_lbbd_vs_resched.py [--time-limit 120]

Writes evidence/benchmarks/results_lbbd_vs_resched.csv in the results_for_solver.csv layout, row by
row, so an interrupted run keeps what it finished. BKS is the ub from ReSched's
BenchDataSolution.csv, overridden by the newer bks in results_for_solver.csv where it has one.
"""

import argparse
import csv
import time
from datetime import datetime

import gurobipy as gp
from bench_resched_vs_benders import ROOT, TNNLS, parse_fjs, run_resched, to_input

from floorsync_common.scheduling.FJSP_lbbd import TIME_LIMIT_SECONDS, lbbd
from floorsync_common.scheduling.gurobi_exact_solver import adapt_scheduling_input

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
    run_resched(to_input(*parse_fjs(todo[0][1])))  # warm-up: the first call pays the torch import

    with open(args.out, "w", newline="") as file:
        writer = csv.DictWriter(file, FIELDS)
        writer.writeheader()
        for name, path, bks in todo:
            problem = to_input(*parse_fjs(path))
            for method in ("resched", "cp-lbbd"):
                run_at = datetime.now().isoformat(timespec="seconds")
                if method == "resched":
                    result = run_resched(problem)
                    result = {
                        "makespan": result.get("makespan"),
                        "seconds": result["runtime_s"],
                        "status": "heuristic" if result["status"] == "ok" else result["status"],
                    }
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
