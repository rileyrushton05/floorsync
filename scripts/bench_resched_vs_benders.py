"""Benchmark the ReSched policy against logic-based Benders (and the monolithic MILP) on FJSP.

Every instance goes through the same `SchedulingInput` the product builds, so ReSched runs through
`ReSchedEngine.generate` exactly as in production and the Gurobi solvers through
`adapt_scheduling_input`. References are the literature bounds shipped with the ReSched submodule
(Brandimarte) and the 1800 s OR-Tools makespans for its SD1 synthetic sets.

    GRB_LICENSE_FILE=$PWD/gurobi.lic uv run --extra resched \
        python scripts/bench_resched_vs_benders.py

Writes results.csv (one row per instance x solver) and history.csv (Benders bounds over time) to
--out, row by row, so an interrupted run keeps what it finished. Plot with
scripts/plot_resched_vs_benders.py.
"""

import argparse
import csv
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src/backend/common"))

import gurobipy as gp  # noqa: E402
import numpy as np  # noqa: E402

from floorsync_common.FJSP_benders import benders  # noqa: E402
from floorsync_common.scheduling.contracts import (  # noqa: E402
    DependencySpec,
    MachineSpec,
    OperationSpec,
    RouteSpec,
    ScheduleGenerated,
    SchedulingInput,
)
from floorsync_common.scheduling.gurobi_exact_solver import (  # noqa: E402
    adapt_scheduling_input,
    build_model,
)
from floorsync_common.scheduling.resched import ReSchedEngine  # noqa: E402
from floorsync_common.seed.flexible import load_flexible_instance  # noqa: E402

TNNLS = ROOT / "src/backend/third_party/ReSched/data/FJSP/TNNLS"
SD_SIZES = {"sd10x5": "10x5", "sd20x5": "20x5", "sd15x10": "15x10"}
FIELDS = [
    "instance",
    "set",
    "n_jobs",
    "n_machines",
    "n_ops",
    "solver",
    "time_limit_s",
    "status",
    "makespan",
    "lb",
    "proven_optimal",
    "runtime_s",
    "iterations",
    "ref_makespan",
    "ref_lb",
]

type Candidates = list[list[tuple[int, int]]]  # per operation: (machine, duration) options
type Edges = list[tuple[int, int]]  # (before, after) operation indexes


def parse_fjs(path: Path) -> tuple[Candidates, Edges]:
    """Standard .fjs text: header, then per job `n_ops (k (machine duration)*k)*n_ops`."""
    lines = [line.split() for line in path.read_text().splitlines() if line.strip()]
    n_jobs = int(lines[0][0])
    candidates: Candidates = []
    edges: Edges = []
    for row in lines[1 : n_jobs + 1]:
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
    return candidates, edges


def to_input(candidates: Candidates, edges: Edges) -> SchedulingInput:
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


def instances(sets: list[str], sd_count: int):
    """Yield (name, set, candidates, edges, ref_makespan, ref_lb)."""
    if "seeded" in sets:
        # tiny, Benders proves these optimal; behnke58/dafjs01 are assembly trees ReSched refuses
        for name in ("fattahi1", "kacem1"):
            instance = load_flexible_instance(name)
            index = {op.id: i for i, op in enumerate(instance.operations)}
            candidates = [
                [(c.machine, c.duration) for c in op.candidates] for op in instance.operations
            ]
            edges = [(index[a], index[b]) for a, b in instance.dependencies]
            yield name, "seeded", candidates, edges, None, None

    for key, size in SD_SIZES.items():
        if key not in sets:
            continue
        # same order ReSched's own loader pairs files with the OR-Tools rows in
        files = sorted(
            (TNNLS / "SD1" / size).glob("*.fjs"), key=lambda p: int(re.findall(r"\d+", p.name)[0])
        )
        reference = np.load(TNNLS / "or_solution" / "SD1" / f"solution_{size}.npy")[:, 0]
        for path, ref in list(zip(files, reference, strict=True))[:sd_count]:
            yield path.stem, key, *parse_fjs(path), float(ref), None

    if "brandimarte" in sets:
        with open(TNNLS / "BenchData" / "BenchDataSolution.csv", encoding="utf-8-sig") as file:
            bounds = {row["filename"]: row for row in csv.DictReader(file)}
        for k in range(1, 11):
            row = bounds[f"BrandimarteMk{k}"]
            path = TNNLS / "BenchData" / "Brandimarte" / f"BrandimarteMk{k}.fjs"
            yield f"mk{k:02d}", "brandimarte", *parse_fjs(path), float(row["ub"]), float(row["lb"])


def run_resched(problem: SchedulingInput) -> dict:
    started = time.perf_counter()
    try:
        result = ReSchedEngine.generate(problem)
    except Exception as error:  # the learned model itself can crash on shapes it never trained on
        return {"status": f"crashed: {error!r}", "runtime_s": time.perf_counter() - started}
    runtime = time.perf_counter() - started
    if not isinstance(result, ScheduleGenerated):
        return {"status": type(result).__name__, "runtime_s": runtime}
    return {"status": "ok", "makespan": result.plan.metrics.makespan_minutes, "runtime_s": runtime}


def run_benders(problem: SchedulingInput, time_limit: float, history: list) -> dict:
    operations, eligible, op_list, machine_meta = adapt_scheduling_input(problem)
    started = time.perf_counter()
    try:
        makespan, _, _, iterations = benders(
            [],
            list(range(len(machine_meta))),
            operations,
            eligible,
            op_list,
            max_iterations=10**6,
            time_limit=time_limit,
            verbose=False,
            history=history,
        )
    except RuntimeError as error:
        return {"status": str(error), "runtime_s": time.perf_counter() - started}
    lb = history[-1][1]
    return {
        "status": "ok",
        "makespan": makespan,
        "lb": lb,
        "proven_optimal": makespan - lb < 1,
        "runtime_s": time.perf_counter() - started,
        "iterations": iterations,
    }


def run_monolithic(problem: SchedulingInput, time_limit: float) -> dict:
    operations, eligible, op_list, _ = adapt_scheduling_input(problem)
    model, _, _, makespan = build_model(operations, eligible, op_list)
    model.Params.TimeLimit = time_limit
    started = time.perf_counter()
    model.optimize()
    runtime = time.perf_counter() - started
    if model.SolCount == 0:
        return {"status": "no_solution", "runtime_s": runtime}
    return {
        "status": "ok",
        "makespan": round(makespan.X),
        "lb": model.ObjBound,
        "proven_optimal": model.Status == gp.GRB.OPTIMAL,
        "runtime_s": runtime,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--sets",
        nargs="+",
        default=["seeded", "sd10x5", "sd20x5", "brandimarte"],
        choices=["seeded", *SD_SIZES, "brandimarte"],
    )
    parser.add_argument("--sd-count", type=int, default=20, help="instances per SD1 size (max 100)")
    parser.add_argument("--time-limits", type=float, nargs="+", default=[60, 300])
    parser.add_argument("--no-monolithic", action="store_true")
    parser.add_argument("--threads", type=int, default=4, help="same for Gurobi and torch")
    parser.add_argument("--out", type=Path, default=ROOT / "evidence/benchmarks/resched-vs-benders")
    args = parser.parse_args()

    gp.setParam("OutputFlag", 0)
    gp.setParam("Threads", args.threads)
    try:
        import torch

        torch.set_num_threads(args.threads)
    except ImportError:
        pass  # ReSched rows will then say ReSchedRuntimeUnavailable

    _, _, candidates, edges, *_ = next(instances(["seeded"], 0))
    run_resched(to_input(candidates, edges))  # warm-up: the first call pays the torch import
    args.out.mkdir(parents=True, exist_ok=True)
    with (
        open(args.out / "results.csv", "w", newline="") as results_file,
        open(args.out / "history.csv", "w", newline="") as history_file,
    ):
        results = csv.DictWriter(results_file, FIELDS)
        results.writeheader()
        histories = csv.writer(history_file)
        histories.writerow(["instance", "solver", "t_s", "lb", "ub"])

        for name, set_name, candidates, edges, ref, ref_lb in instances(args.sets, args.sd_count):
            problem = to_input(candidates, edges)
            base = {
                "instance": name,
                "set": set_name,
                "n_jobs": len(candidates) - len(edges),
                "n_machines": len(problem.machines),
                "n_ops": len(candidates),
                "ref_makespan": ref,
                "ref_lb": ref_lb,
            }

            # (solver, time limit, Benders history to fill -- None for the others)
            longest = max(args.time_limits)
            runs = [("resched", None, None)]
            runs += [(f"benders_{limit:g}s", limit, []) for limit in args.time_limits]
            if not args.no_monolithic:
                runs.append((f"monolithic_{longest:g}s", longest, None))

            for solver, limit, history in runs:
                if solver == "resched":
                    result = run_resched(problem)
                elif history is not None:
                    result = run_benders(problem, limit, history)
                else:
                    result = run_monolithic(problem, limit)
                row = base | {"solver": solver, "time_limit_s": limit} | result
                results.writerow(row)
                results_file.flush()
                print(
                    f"{name:>14} {solver:>16}  {row['status']:>4}  Cmax={row.get('makespan')}"
                    f"  ref={ref}  {row['runtime_s']:.2f}s",
                    flush=True,
                )
                if history is not None:
                    histories.writerows((name, solver, t, lb, ub) for t, lb, ub in history)
                    history_file.flush()


if __name__ == "__main__":
    main()
