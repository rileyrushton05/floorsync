# Scheduling design

FloorSync is a **flexible job-shop scheduling** problem: each operation can have multiple compatible
machines, each option can have a different processing duration, operations are connected by a
dependency DAG, and a machine can do at most one operation at a time. Known maintenance/reservation
windows are hard calendar constraints.

A manager picks one of two strategies per generation run (`strategy` on the request):

| Strategy | Engine | Stored as | Strength |
| --- | --- | --- | --- |
| `resched` (default) | MIT-licensed [ReSched](https://github.com/XiangjieXiao/ReSched) REINFORCE policy | `resched_reinforce_v1` | Fast greedy inference; linear job chains only |
| `exact` | Critical-path-search LBBD: Gurobi master + OR-Tools CP-SAT ([decision 0021](decisions/0021-cp-lbbd-exact-solver.md)) | `exact_lbbd_v1` | Any acyclic precedence graph; reports a proven lower bound and gap |

FloorSync keeps each engine's decisions separate from its own validation and schedule-version
persistence. This prevents a solver or ML inference result from ever bypassing production
constraints.

Both engines minimise makespan only. Energy and labour cost are computed from the chosen
assignment and stored for reporting, but they do not influence it
([decision 0014](decisions/0014-fajsp_milp_formulation.md), point 2). Job priority is informational:
it is not part of `SchedulingInput`, and no engine reads it
([decision 0021](decisions/0021-cp-lbbd-exact-solver.md), point 5).

## Scheduling contract

The engine receives an immutable `SchedulingInput`, assembled in one database transaction from:

| Input | Source | Meaning |
| --- | --- | --- |
| Operations | `operations` | Work that must be assigned exactly once. |
| Routes | `compatibilities` | Allowed operation-machine pairs, each with duration and energy. |
| Precedence | `dependencies` | Directed `before -> after` hard constraints, including cross-job assembly dependencies. |
| Resources | active `machines` | One capacity unit per machine and its cost per minute. |
| Calendar blocks | `unavailabilities` | Intervals that no operation may overlap. |
| Planning origin | generation request | Timezone-aware timestamp from which the schedule may begin. |

The engine returns either a complete `SchedulePlan` or a typed `SchedulingInputInvalid` result.
It never emits or persists a partial plan. Validation reports duplicate IDs/edges, unknown
references, missing active routes, non-positive durations, invalid downtime and dependency cycles
before placement begins.

## ReSched adapter

`ReSchedEngine` converts a standard FloorSync job-shop input into ReSched's FJSP duration,
dependency and operation-machine tensors, runs greedy inference with the bundled `Old-SD1-10x05`
REINFORCE checkpoint, then maps ReSched's output directly to FloorSync assignments and metrics:

1. Validate the full input and reject cycles or unroutable operations.
2. Require disjoint, linear operation chains; the adapter derives each ReSched job and operation
   position from those chains.
3. Run ReSched unchanged and translate its chosen machine plus start/end offsets to FloorSync UUIDs
   and timestamps.
4. Store ReSched's complete output as a draft schedule.

ReSched is trained for conventional FJSP inputs, so FloorSync deliberately rejects downtime windows,
fan-in/fan-out dependencies and any other non-linear job graph. It is safer to return a structured
validation error than silently alter a ReSched result with a second scheduling algorithm. Machine
counts unlike the selected checkpoint are permitted but must be evaluated before relying on quality.

Two kinds of check apply to an input, and they are kept apart (#133). *Data coherence* (an
operation nothing active can run, a non-positive duration, a precedence cycle, duplicate or
dangling references) is a property of the floor and lives once in `scheduling/input_checks.py`,
which imports nothing but the contracts and the pure graph helper;
both worker tasks run it before their engine, and `GET /api/v1/schedules/validation` runs it on
demand so a manager can see what is wrong before generating. *Strategy limits* (ReSched's linear
chains, neither engine's lack of downtime modelling) are a property of the engine and are reported
per strategy as *unsupported*, never as invalid: fan-in is legitimate data that the exact solver
takes (#216). A cycle names every operation caught in it, whichever path reports it.

The upstream code is tracked as `src/backend/third_party/ReSched` at a pinned git-submodule revision.
Install the learned runtime with `uv sync --extra resched`; this adds NumPy and a Python 3.12-
compatible PyTorch runtime (the upstream repository pins PyTorch 2.3.1). If the optional runtime or checkpoint is unavailable, the service returns
the explicit `ReSchedRuntimeUnavailable` outcome and writes no schedule.

## Exact solver

The `exact` strategy runs `generate_schedule_exact` in `floorsync_workers/tasks/schedules.py`:

1. Run the shared input checks, then the exact solver's strategy limits. Machine downtime is
   reported as `unsupported_unavailability`, because neither formulation models it.
2. `gurobi_exact_solver.adapt_scheduling_input` drops inactive machines and turns the snapshot into
   index-based arrays: one `OpRecord` per operation, holding its `(duration, machine)` options,
   predecessors and energy per machine. Machines and operations are ordered by id, so the same
   input always gives the same indices and the same tie-break among optimal schedules. An operation
   with no active route is rejected as `no_compatible_machine`.
3. `FJSP_lbbd.solve_fajsp` solves the arrays (below).
4. `gurobi_exact_solver.build_schedule_plan` converts machine indices and minute offsets into a
   `SchedulePlan`. It adds `job_order` edges from the precedence graph and `machine_queue` edges
   between consecutive operations on a machine, the same as ReSched's `_to_plan`, and totals energy
   and labour cost.

### Formulation (CP-LBBD)

`FJSP_lbbd.py` follows Naderi & Roshanaei (2022), with the deviations listed in its module docstring.
It splits the problem into *which machine* and *in what order*:

| Part | Solver | What it does |
| --- | --- | --- |
| Warm start | CP-SAT | Whole problem as one CP model (optional intervals + `NoOverlap`) for up to half the budget. Seeds the incumbent and the lower bound. |
| Assignment master (AMP) | Gurobi | Picks a machine per operation, minimising a relaxation of makespan: per-operation head + duration + tail over the precedence DAG, plus the per-machine release + workload + tail bound (Relaxation B.2). Its objective is a valid **lower bound**. |
| SSSP1 | CP-SAT | Sequences the master's fixed assignment. Its makespan is a feasible **upper bound**. |
| SSSP2 | CP-SAT | Up to 3 rounds where only the critical-path operations may change machine, to improve the upper bound. |
| Cuts | Gurobi | After each subproblem, a cut `Cmax >= bound - sum c_i * (1 - z[i, m(i)])`. It is restricted to the critical operations when they alone force the same bound. `c_i` uses the safe shift-and-insert coefficient, because the paper's `c_i = p_i` is unsound once operations have release times. |

The loop stops when the lower bound reaches the incumbent or the deadline passes. The best
schedule is left-shifted before it is returned.

`gurobi_exact_solver.build_model` is the earlier monolithic big-M MILP. It is no longer wired to
`exact` and is kept as a reference and test oracle: `test_gurobi_exact_solver.py` runs both engines
on the same instances. `floorsync_common/FJSP_benders.py` is an earlier, unshipped Benders
experiment, used only by `scripts/bench_resched_vs_benders.py` and tests.

### Outcomes

| Result | Meaning |
| --- | --- |
| `completed` | A draft was stored. The task result carries `proven_optimal` and `gap` = (makespan − lower bound) / makespan. |
| `rejected` (issue `infeasible`) | `NoFeasibleSchedule`: no feasible schedule was found within the time limit. |
| `unavailable` | `GurobiError`, typically a missing or expired licence. |

Install with `uv sync --extra exact` (`gurobipy`, `ortools`). The master needs a Gurobi licence.

## Persistence and API boundary

Each successful run becomes a new `draft` schedule; it never overwrites a confirmed schedule.
`schedules.strategy`, `runtime_ms`, `input_operation_count`, `makespan`, `total_energy` and
`total_labour_cost` form the run-history record. `schedule_entries` snapshots the selected route,
duration and machine cost.

`schedule_dependencies` records *why* an operation waits (`job_order` or `machine_queue`) and is
used with snapshotted durations to derive a schedule timeline when it is read.

`POST /api/v1/schedules` is manager-only and accepts a timezone-aware `starts_at`. It publishes a
`floorsync.schedules.generate` command to the `scheduling` Celery queue, then returns `202 Accepted`
with a `Location` pointing to `/api/v1/schedules/generations/{generation_id}`. The API process never
runs ReSched or holds a database transaction during inference.

The worker reads a configuration snapshot in a short transaction, closes it, runs the pure engine,
then persists the resulting draft in a separate short transaction. `GET` on the generation resource
reports `pending`, `running`, `completed`, `rejected`, `unavailable` or `failed`. A completed result
links to `GET /api/v1/schedules/{schedule_id}`, which retrieves the saved version, entries and
dependency graph. Rejected runs expose their machine-readable validation issues in the status
resource; queue outages are RFC 9457 `503` Problem Details. The engine itself remains database- and
FastAPI-free.

## Evaluation

Every scenario run records the snapshot size, strategy, runtime and metrics. Report makespan
(minutes), total energy, labour cost and runtime (ms), and compare those results with published or
separately generated FJSP benchmarks. Do not claim results for calendar- or DAG-extended inputs:
they are intentionally outside this adapter's supported contract.

### Generation speed versus solution quality

The two strategies sit at opposite ends of the same trade-off:

- **ReSched** runs one greedy pass of a trained policy. It returns quickly and has no time budget,
  but it has no lower bound. There is no way to tell how far its
  makespan is from optimal, other than comparing with the exact solver or published optima.
- **Exact (CP-LBBD)** spends up to `TIME_LIMIT_SECONDS` (120 s) per run, inside the planner's
  180 s poll deadline. Up to half of that goes to the CP warm start, and each CP subproblem is
  capped at `SUB_TIME` (30 s). In return, every run states how good its result is: `proven_optimal`
  when the lower bound meets the makespan, otherwise `gap`. Small instances, such as `fattahi1` and `kacem1` in
  `test_fjsp_lbbd.py`, prove optimal well inside the budget. Larger ones run to the deadline and return the best schedule found, with a non-zero
  gap. They never return nothing, unless no feasible schedule was found at all.
- A larger budget gives the exact solver more time to close its gap. A smaller one trades proof
  for speed, and the warm start keeps a schedule available early. The budget is a single constant:
  the worker's Celery soft/hard limits are derived from it (+30 s / +45 s), and must stay under the
  planner's 180 s deadline.

The earlier monolithic MILP and the first Benders split sit on the same curve but are slower to
close the gap, which is why `exact` moved to CP-LBBD
([decision 0021](decisions/0021-cp-lbbd-exact-solver.md)).

Current scope is offline planning only. A machine failure after confirmation is a simulation/event
concern, not silent schedule repair; a later rescheduling feature should create a new draft from a
fresh snapshot.
