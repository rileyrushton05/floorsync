# Decision: Derive the simulation timeline from one format-neutral resolver

## Date

2026-09-05

## Status

Accepted. Point 1 is superseded for FloorSync schedules by
[decision 0011](0011-store-floorsync-start-times.md), which stores the scheduler's own start time
instead of re-deriving it; this decision still governs benchmark instances, and points 2-8 still
describe the shared vocabulary and derived queue position for both sources.

## Context

Playback needs a start and end time for every scheduled operation, but no table stores one.
`schedule_entries` deliberately holds no start time and no queue position, because both are derived
from `schedule_dependencies` at read time (see `docs/database-schema.md` and #125).

Two independent sources of schedules need the same arithmetic. A FloorSync schedule arrives as
`schedule_entries` rows plus `schedule_dependencies` rows already labelled `job_order` or
`machine_queue`. A benchmark instance arrives as two JSON files, deliberately outside the database,
where the equivalent edges are implicit: job precedence is the operation order within a job, and
machine queueing is the visiting order recorded per machine in a solver's solution.

The two also differ in shape. A benchmark job is a strict linear chain of operations identified by
small integers. A FloorSync process is a DAG over `dependencies` that supports several predecessors
per operation and edges crossing jobs, over UUID-identified entities that carry names an operator
must recognise on screen.

An earlier draft of the simulation package modelled only the benchmark shape, with integer job and
machine identifiers and a per-job chain built into the resolver. It could not represent a FloorSync
schedule at all.

## Decision

1. Do not persist derived timing. Start times, end times, machine queue positions, machine state and
   job state are recomputed on read and never written to a table.
2. Express the resolver over a format-neutral vocabulary in
   `floorsync_common.simulation.graph`: a `TimelineNode` carrying an opaque string key, a job key, a
   machine key, a duration and display labels; a `PrecedenceEdge` carrying `before`, `after` and a
   `PrecedenceReason`.
3. Keep `PrecedenceReason` values identical to the `schedule_dependencies.reason` check constraint
   (`job_order`, `machine_queue`) so a stored row becomes an edge without translation.
4. Resolve start times with a single topological longest path over that graph, in
   `resolve_start_times()`. It is the only implementation of the arithmetic.
5. Put format knowledge in adapters, never in the resolver:
   - `FloorSyncScheduleAdapter` translates schedule rows, whose edges already exist;
   - `TimelineBuilder` translates a benchmark instance and solution, deriving the edges the database
     would have stored.
6. Have adapters accept plain frozen records (`ScheduleEntryRecord`, `ScheduleDependencyRecord`)
   rather than ORM instances or an `AsyncSession`, so a timeline resolves without a database.
7. Derive each operation's machine queue position from the resolved start times rather than storing
   or trusting an input ordering.
8. Carry display names on every node, so machine and job identity reaching the UI is a real name
   rather than an opaque key.

## Rationale

- The correctness question — does this schedule respect precedence and machine exclusivity — is
  identical for both sources, so it deserves one implementation and one set of tests.
- Derived timing cannot drift from the schedule it came from, which a stored copy eventually would.
  It is also cheap: the resolution is linear in operations plus edges.
- Opaque string keys are the smallest thing both a `UUID` and a benchmark `job:operation` pair can
  become, and they keep the resolver from depending on either identity scheme.
- Reusing the stored `reason` values means the disposable `schedule_dependencies` cache is consumed
  as-is, and a mismatch surfaces as a validation error rather than a silent misread.
- Plain records keep the resolver testable without PostgreSQL and leave the loading query where
  decision 0005 wants it, as a named `load_schedule_inputs()` read in the service layer.
- Two operations on one machine can never share a start time in a feasible schedule, so ordering by
  start time reproduces the queue exactly. Deriving the position removes a field that could disagree
  with the timing beside it.
- Names on nodes mean a Gantt lane can read `Cutter` rather than a UUID, without the renderer
  performing its own lookups.

## Alternatives considered

- **Store start and end times on `schedule_entries`:** rejected. It contradicts #125, adds columns
  that must be recomputed whenever dependencies are rebuilt, and creates a second source of truth for
  something already implied by the rows beside it.
- **Two separate implementations, one per source:** rejected. The arithmetic is the part most likely
  to be subtly wrong, and duplicating it doubles the places a fix has to land.
- **Make the FloorSync path the only path and convert benchmark files into schedule rows first:**
  rejected. Benchmark instances are explicitly out of the database, and forcing them through
  UUID-shaped records to read a file would be ceremony without benefit.
- **Make the resolver generic over an identity type:** rejected as more type machinery than the
  problem needs; a string key costs one conversion at each adapter boundary and nothing after that.
- **Have adapters accept ORM instances directly:** rejected. It would drag SQLAlchemy and eager
  loading requirements into a pure calculation and make every unit test need a session.

## Consequences

- A timeline is resolved on every read. If a large schedule ever makes that visible, the fix is a
  cache keyed by schedule id and invalidated on regeneration, not stored columns.
- Adding a third schedule source means writing an adapter only; the resolver does not change.
- The resolver cannot detect an infeasible schedule that is merely inefficient. It raises
  `CyclicScheduleError` for a deadlock and `ScheduleMismatchError` for rows that do not describe the
  same schedule, and reports nothing about quality. Feasibility checking beyond that remains
  application-level, as `docs/database-schema.md` records.
- A stale `schedule_dependencies` cache surfaces as `ScheduleMismatchError` naming the offending
  entry, rather than as a timeline that is quietly wrong.
- The loading query is still owed: the adapter defines the record shape it needs, and
  `load_schedule_inputs()` has to produce it.
