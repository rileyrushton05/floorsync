# Simulation — schedule playback

Replays a **solved** job shop schedule over simulated time so the floor's state at
any instant can be rendered and scrubbed through. Deterministic: no stochastic
durations, no breakdowns, no re-dispatching. It replays a decision that has
already been made.

## Layers

Each layer is usable and testable without the one above it.

| Layer | Classes | Responsibility |
| --- | --- | --- |
| Problem definition | `Operation`, `JobShopInstance` | Parse an instance document into the work that exists and each job's routing. No timing. |
| Timeline resolution | `Schedule`, `TimelineBuilder`, `ScheduledOperation`, `Timeline` | Turn machine sequences plus job precedence into concrete start and end times. |
| Playback runtime | `PlaybackClock`, `SimulationEngine`, `SimulationObserver`, `MachineState`, `JobState`, `SimulationSnapshot` | Move over the timeline and publish a snapshot of every machine and job. |

## Usage

```python
from floorsync_common.simulation import SimulationEngine

engine = SimulationEngine()
engine.load_instance("instances/json/ft06.json")
engine.load_schedule("solutions_CP-SAT_2026-08-30.json")

engine.subscribe(lambda snapshot: render(snapshot))  # object with on_update() also works
engine.play()
engine.tick(0.016)  # drive from a frame loop; real seconds, scaled by clock speed
engine.seek_fraction(0.5)  # or drive from a scrubber

for frame in engine.frames(step=1.0):  # headless walk, useful in tests and exports
    ...
```

`SimulationSnapshot` carries `time`, `makespan`, `machines`, `jobs`, `active` and
`is_complete` — everything a renderer needs for one frame, and nothing about how
it is drawn.

## Input formats

**Instance** (`instances/json/*.json`) — what work exists:

```json
{"instance": "ft06", "machines": 6, "jobs": 6,
 "data": [{"job": 0, "operation": 0, "machine": 2, "duration": 1}]}
```

**Solution** (`solutions_{solver}_{date}.json`) — the order jobs occupy each
machine, with no timing:

```json
{"instance": "ft06", "makespan": 55, "machine_0": [0, 5, 2, 4, 3, 1]}
```

A solver run writes an array of these, so pass `instance_name` to
`load_schedule` when a file holds more than one solution.

## Notes for future work

- **Reentrant jobs are supported.** When a job visits one machine more than once
  it appears in that machine's sequence more than once, and occurrences bind in
  order: the first appearance of job `j` in machine `m`'s sequence is `j`'s first
  operation on `m`. `test_builder_binds_repeat_visits_in_sequence_order` covers
  this; the `ft*` and `la*` families do not exercise it, `dmu*` and `ta*` do.
- **Infeasible schedules raise rather than mislead.** `ScheduleMismatchError`
  means the schedule does not describe this instance; `CyclicScheduleError` means
  the sequencing deadlocks, so no valid start times exist.
- **Cross-check against solver output.** `TimelineBuilder` recomputes the makespan
  independently, so a timeline's makespan should equal the `makespan` recorded in
  the solution file. A mismatch means one of the two is wrong.
- **Not yet decided:** whether the UI shows a best-known-solution reference line
  from `bks.json`, and how repeat machine visits should be distinguished visually.

## Tests

```bash
uv run pytest tests/backend/test_simulation.py
```
