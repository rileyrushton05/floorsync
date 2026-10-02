# Simulation — schedule playback

Replays a **generated** schedule over simulated time so the floor's state at any instant can be
rendered and scrubbed through. Deterministic: no stochastic durations, no breakdowns, no
re-dispatching. It replays a decision that has already been made.

Three decisions govern this package:

- [0009: derived simulation timeline](../../../../../docs/decisions/0009-derived-simulation-timeline.md)
  — benchmark instances, which carry no stored timing, still resolve it on read with a topological
  longest path.
- [0011: store FloorSync start times](../../../../../docs/decisions/0011-store-floorsync-start-times.md)
  — FloorSync schedules carry the scheduler's own start time on `schedule_entries` and it is read
  as-is; only end time and queue position are still derived.
- [0010: event-sourced simulated time](../../../../../docs/decisions/0010-event-sourced-simulated-time.md)
  — a stored simulation's position comes from replaying `simulation_events`, not from a clock.

## Layers

| Layer | Module | Responsibility |
| --- | --- | --- |
| Core | `graph.py` | `TimelineNode`, `PrecedenceEdge`, `PrecedenceReason` and `resolve_start_times()` — the topological longest path used by benchmark instances, keyed by opaque strings so it is format-neutral. |
| Adapter | `floorsync.py` | Translates `schedule_entries` rows, reading the `start_time` the scheduler already resolved. |
| Adapter | `builder.py`, `instance.py`, `schedule.py` | Translates a benchmark instance and solver solution, deriving the edges a FloorSync schedule doesn't need. |
| Playback | `timeline.py`, `state.py` | `Timeline` answers "what is true at time `t`" as `MachineState` / `JobState` / `SimulationSnapshot`. |
| Playback | `events.py` | `derive_simulated_time()` replays a simulation's control log to find that `t` authoritatively. |
| Playback | `clock.py`, `engine.py` | `PlaybackClock` and `SimulationEngine` animate locally between derived positions. |
| Application | `queries.py`, `service.py`, `results.py` | The only DB-touching modules: named reads, `ScheduleTimelineService` / `SimulationService`, and their typed outcomes. |

Everything above the application row is pure. `queries.py` and `service.py` are the only modules
that import SQLAlchemy, so the resolver and the event replay stay testable without a database.

## FloorSync schedules

`schedule_entries` supply the work, including the `duration` snapshotted from Compatibility at
generation time and the `start_time` the scheduler resolved at generation time (decision 0011). The
adapter takes plain records rather than ORM instances, so a timeline builds without a session and
the loading query stays a named `load_schedule_entries()` read in the service layer, per decision
0005.

```python
from floorsync_common.simulation import FloorSyncScheduleAdapter, SimulationEngine

entries = FloorSyncScheduleAdapter.entries_from_rows(entry_rows)
timeline = FloorSyncScheduleAdapter.build_timeline(entries)
```

The expected row shape is `entry_id, job_id, machine_id, duration, job_name, machine_name,
operation_name, start_time`. `schedule_dependencies` still exists and still backs
`GET /schedules/{id}`'s dependency-graph response, but this package no longer reads it.

Because names travel with each node, a Gantt lane reads `Cutter` rather than a UUID, and the
renderer performs no lookups of its own.

## Simulated time

A stored simulation's position is derived, never read from `started_at` and `speed` — that
expression keeps advancing while playback is paused, which is exactly what US24 forbids.

```python
from floorsync_common.simulation import derive_simulated_time, events_from_rows

point = derive_simulated_time(
    events_from_rows(event_rows), at=datetime.now(UTC), makespan=timeline.makespan
)
engine = SimulationEngine(timeline)
engine.seek(point.time)  # resynchronise the local player to the authoritative position
```

Every control action must append a `simulation_events` row. A pause that only updates
`simulations.status` is invisible to the derivation, and position will keep advancing.

`PlaybackClock` and `SimulationEngine` drive animation between those positions and headless work:

```python
engine.play()
engine.tick(0.016)  # real seconds since the last frame, scaled by clock speed
engine.seek_fraction(0.5)  # or drive from a scrubber

for frame in engine.frames(step=1.0):  # headless walk, useful in tests and exports
    ...
```

`SimulationSnapshot` carries `time`, `makespan`, `machines`, `jobs`, `active` and `is_complete` —
everything a renderer needs for one frame, and nothing about how it is drawn.

## Benchmark instances

Benchmark instances stay out of the database entirely, so this path reads the two file formats the
benchmarking work produces:

```json
{"instance": "ft06", "machines": 6, "jobs": 6,
 "data": [{"job": 0, "operation": 0, "machine": 2, "duration": 1}]}
```

```json
{"instance": "ft06", "makespan": 55, "solver": "CP-SAT", "machine_0": [0, 5, 2, 4, 3, 1]}
```

```python
engine = SimulationEngine()
engine.load_instance("instances/json/ft06.json")
engine.load_schedule("solutions_CP-SAT_2026-08-30.json")
```

A solver run writes an array of solutions, so pass `instance_name` when a file holds more than one.

Reentrant visits are supported: when a job appears in a machine's sequence more than once,
occurrences bind in order — the first appearance of job `j` on machine `m` is `j`'s first operation
there. The `ft*` and `la*` families do not exercise this; `dmu*` and `ta*` do.

## HTTP surface

`floorsync_api.features.simulation` exposes five endpoints, all under `/api/v1`:

| Endpoint | Purpose |
| --- | --- |
| `GET /schedules/{schedule_id}/timeline` | The resolved timeline. Immutable for a confirmed schedule, so fetch once for geometry. |
| `GET /schedules/{schedule_id}/simulation` | Recover that schedule's persisted simulation position; `404` means it has not been started. |
| `POST /simulations` | Create the simulation for a confirmed schedule. One per schedule. |
| `GET /simulations/{simulation_id}` | The position derived from the event log right now. |
| `POST /simulations/{simulation_id}/events` | Record a control action and return the resulting position. |

Reads are open to any signed-in account so operators can watch; control actions require a manager.

## Errors

| Error | Meaning |
| --- | --- |
| `ScheduleMismatchError` | The rows do not describe one schedule — a FloorSync entry with no stored `start_time` (predates decision 0011), or a benchmark sequence that does not match its instance. |
| `CyclicScheduleError` | Precedence and machine queueing deadlock, so no feasible start times exist. |
| `SimulationTimelineError` | An event log cannot be replayed — a naive timestamp, a missing or non-positive speed, or an unknown event type. |
| `InstanceFormatError`, `ScheduleFormatError` | A benchmark document is malformed. |

## Not in scope

Timelines are never persisted, and neither is playback position per viewer. The resolver reports
deadlock and mismatch, but says nothing about schedule quality; feasibility checking beyond that is
application-level (#132, #142/#179). The operator break countdown runs on real wall-clock time and is
unrelated to this package.

## Tests

```bash
uv run pytest tests/backend/test_simulation.py
```
