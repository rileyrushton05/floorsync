# Scheduling design

FloorSync is a **flexible job-shop scheduling** problem: each operation can have multiple compatible
machines, each option can have a different processing duration, operations are connected by a
dependency DAG, and a machine can do at most one operation at a time. Known maintenance/reservation
windows are hard calendar constraints.

The production dispatch policy is based on the MIT-licensed
[ReSched](https://github.com/XiangjieXiao/ReSched) REINFORCE FJSP implementation. FloorSync keeps
the model's operation-machine decision policy separate from its own validation, calendar-aware
feasibility projection and schedule-version persistence. This prevents an ML inference result from
ever bypassing production constraints.

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

The upstream code is tracked as `src/backend/third_party/ReSched` at a pinned git-submodule revision.
Install the learned runtime with `uv sync --extra resched`; this adds NumPy and a Python 3.12-
compatible PyTorch runtime (the upstream repository pins PyTorch 2.3.1). If the optional runtime or checkpoint is unavailable, the service returns
the explicit `ReSchedRuntimeUnavailable` outcome and writes no schedule.

## Persistence and API boundary

Each successful run becomes a new `draft` schedule; it never overwrites a confirmed schedule.
`schedules.strategy`, `runtime_ms`, `input_operation_count`, `makespan`, `total_energy` and
`total_labour_cost` form the run-history record. `schedule_entries` snapshots the selected route
and machine cost plus authoritative `starts_at` and `ends_at` timestamps. The timestamps are
essential: a dependency graph cannot reconstruct idle gaps caused by maintenance, and using live
downtime later would mutate a historical plan.

`schedule_dependencies` remains useful for explaining *why* an operation waits (`job_order` or
`machine_queue`), but is no longer treated as the timeline source of truth.

`SchedulingService.generate_draft()` is the database adapter: it loads the configuration with the
caller-owned transaction, runs the pure engine, and persists the new draft only on success. The API
adapter should expose this as a manager-only `POST /api/v1/schedules` command with a
timezone-aware `starts_at`, returning `201 Created` and the draft schedule. A validation result is
mapped to RFC 9457 `422` Problem Details with the individual issue codes in an extension field.
The request handler owns the transaction; the engine itself remains database- and FastAPI-free.

## Evaluation

Every scenario run records the snapshot size, strategy, runtime and metrics. Report makespan
(minutes), total energy, labour cost and runtime (ms), and compare those results with published or
separately generated FJSP benchmarks. Do not claim results for calendar- or DAG-extended inputs:
they are intentionally outside this adapter's supported contract.

Current scope is offline planning only. A machine failure after confirmation is a simulation/event
concern, not silent schedule repair; a later rescheduling feature should create a new draft from a
fresh snapshot.
