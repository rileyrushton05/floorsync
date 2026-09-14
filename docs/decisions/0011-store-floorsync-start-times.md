# Decision: Store the scheduler's own start times on schedule_entries

## Date

2026-09-10

## Status

Accepted. Supersedes point 1 of [decision 0009](0009-derived-simulation-timeline.md) for FloorSync
schedules only; benchmark instances still resolve timing as 0009 describes, since they carry none
to store.

## Context

Decision 0009 derived every operation's start time at read time, for both schedule sources, with one
resolver over `schedule_entries` and `schedule_dependencies`. That was the right call when
`schedule_dependencies` was the only record of ordering FloorSync schedules had.

It no longer is. `SchedulingService.store_draft` already receives a `SchedulePlan` whose
`ScheduledOperation.starts_at` is the scheduler's own resolved start time -- ReSched computes it
during solving (`resched.py`) and it was simply discarded before being written to
`schedule_entries`. Re-deriving that exact number by walking `schedule_dependencies` at every read
was recomputing a value the schedule already decided, using a second table that exists only to
support the recomputation.

## Decision

1. `schedule_entries.start_time` stores the datetime the scheduler assigned, written once in
   `SchedulingService.store_draft` and never recalculated.
2. `FloorSyncScheduleAdapter.build_timeline` reads `start_time` directly. It no longer takes
   `schedule_dependencies` rows, derives no edges, and runs no graph resolution for FloorSync
   schedules.
3. End time and machine queue position are still derived, not stored -- as `start_time + duration`,
   and by sorting a machine's entries on `start_time` (`Timeline.from_operations`, unchanged). Both
   are pure functions of `start_time`, so storing them would be the second-source-of-truth problem
   0009 already rejected, just moved one field over.
4. `schedule_dependencies` keeps existing: `GET /schedules/{id}` still serves it as part of a
   schedule's public representation, independent of how the timeline gets built. What changes is
   that the simulation package stops being one of its readers.
5. `ScheduleDependencyRecord`, `FloorSyncScheduleAdapter.to_edges`/`dependencies_from_rows`, and
   `queries.load_schedule_dependencies` are removed from the simulation package -- dead code once
   nothing in it reads dependencies for timing.
6. `resolve_start_times()` and the benchmark adapters (`builder.py`, `graph.py`) are unchanged.
   Benchmark instances have no `schedule_entries` row to carry a start time, so they still need the
   longest-path resolution 0009 describes.
7. A FloorSync schedule entry with no stored `start_time` -- one written before this migration --
   raises `ScheduleMismatchError` rather than falling back to derivation. Supporting both paths
   indefinitely would keep the exact duplication 0009 was written to avoid.

## Rationale

- The scheduler already computes a feasible, deadlock-free placement. Re-deriving start times from
  `schedule_dependencies` at read time cannot produce a *different* answer for a valid schedule --
  it can only be a slower way to recompute the same numbers, or silently mask a bug if the two ever
  disagreed.
- Removing the derivation for FloorSync schedules also removes a failure mode 0009 accepted as a
  cost: a stale or malformed `schedule_dependencies` cache could previously produce
  `ScheduleMismatchError`/`CyclicScheduleError` for a schedule whose actual assignments were fine.
  Reading `start_time` directly can't be stale in that way -- it either exists, from the same write
  that created the entry, or it doesn't.
- `schedule_dependencies` earns its keep independently, as the API's dependency-graph resource. This
  decision only removes it as an *input to timing*, which is the part 0009 called disposable.

## Alternatives considered

- **Keep deriving from `schedule_dependencies` for FloorSync schedules too:** rejected -- this is
  what 0009 chose and what this decision changes, now that the scheduler's own number exists and
  the derivation was reproducing it exactly at the cost of a graph walk on every read.
- **Backfill existing rows by deriving once and writing the result:** rejected for this pass. It
  would require running the old resolver as a one-off migration step against production-shaped data
  that doesn't exist yet in this project; regenerating affected schedules is simpler while the
  dataset is still synthetic. `start_time` is nullable for exactly this reason, and `ScheduleMismatchError`
  makes an ungenerated entry loud rather than silently wrong.
- **Also store `end_time` and `machine_slot`:** rejected, for the same reason 0009 rejected storing
  them originally -- both are pure functions of `start_time`, so storing them adds a place for the
  copy to disagree with the source, for a computation cheap enough to redo on every read.
- **Drop `schedule_dependencies` entirely:** rejected. `GET /schedules/{id}` (`floorsync_api.features.schedules.router`)
  serves it as a public resource today, independent of this decision; removing the table is a
  separate, larger call about that API contract.

## Consequences

- `FloorSyncScheduleAdapter.build_timeline(entries)` no longer takes a `dependencies` argument;
  `queries.load_schedule_entries` selects one more column and `ScheduleTimelineService`/
  `SimulationService` no longer load dependencies at all.
- A schedule generated before this migration has `start_time IS NULL` on every entry and cannot be
  simulated until regenerated -- `ScheduleTimelineService.get_timeline` and
  `SimulationService.get_simulation`/`record_control` all surface this as `ScheduleMismatchError`.
- Benchmark instances are unaffected: `TimelineBuilder`, `graph.py`, and their tests are untouched.

## Amendment (2026-09-14, issue #251)

Schema drift left some databases with the legacy `starts_at`/`ends_at` columns this decision
replaced still physically present and `NOT NULL`, because the migration that later removed them
under the same revision id was never actually run there (see #251 for the full history). Any insert
into `schedule_entries` on such a database fails outright, `start_time` or not.

Migration `20260914_0001` fixes this by copying `starts_at` into `start_time` wherever `start_time`
is still null, then dropping the legacy columns. This is **not** the "derive once and backfill"
alternative this decision rejected above: that alternative meant re-running the `schedule_dependencies`
graph resolver to invent a start time for a row that never had one. This is a plain column copy of a
value the scheduler already computed at the time -- `starts_at` was itself real scheduler output, not
a placeholder, so nothing is being derived or guessed. A row with genuinely no timing at all (neither
column populated) is left with `start_time NULL`, unaffected, and still surfaces
`ScheduleMismatchError` exactly as this decision intends.

Separately, #251 also had the seed loader start writing `start_time` for the schedules it creates,
using `resolve_start_times()` (the same longest-path resolver `graph.py` already provides for
benchmark instances). This does not reopen point 2's removal of derivation from `build_timeline` --
that stays read-time-derivation-free. The seed loader is instead acting as the "scheduler" for its
own synthetic data, the same role `ReSchedEngine` plays for a live generation: it decides
`start_time` once, at write time, exactly as `SchedulingService.store_draft` does with
`SchedulePlan.assignments[].starts_at`. No existing row's `start_time` is touched by this part.
