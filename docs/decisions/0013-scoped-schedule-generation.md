# Decision: Scope schedule generation by refusing an incomplete job selection

## Date

2026-09-15

## Status

Accepted. Amended by decision 0019: `job_ids` is now required, so the unscoped whole-floor run
described below no longer exists (#270).

## Context

`POST /api/v1/schedules` took only a `starts_at` and planned every operation in the database, so a
manager could not release part of the backlog. The scheduler page showed the gap directly: the
backlog checkboxes were rendered ticked and disabled, with a note saying scoping was not supported.
See #231.

Scoping a run raises a question the rest of the schema has already answered for operations but not
for jobs. `dependencies` joins *operations*, and is deliberately allowed to join two operations in
different jobs ([decision on cross-job edges, #125](../database-schema.md)). There is no
`job_dependencies` table and no column on `jobs` pointing at another job, which
`test_job_schema_alignment.py` asserts on purpose. So "which jobs does this job need first" is not
a fact the database stores. Any answer has to be derived from operation-level edges.

That matters because a selection can cut such an edge. If job B's first operation waits on job A's
last, scheduling B alone hands the adapter an operation whose predecessor is not in the input.
Dropping the edge silently would produce a schedule that violates a real precedence constraint, and
carrying it would fail deeper in as `unknown_dependency_operation`, which names an operation rather
than the job the manager actually got wrong.

## Decision

1. **Job-level precedence stays derived, never stored.** A job-level edge exists wherever a
   `dependencies` row's two operations belong to different jobs. `jobs.dependency_graph`'s single
   SELECT is the only definition of that, and no table or column is added to cache it.
2. **The closure walks backwards only.** Selecting job B requires every job B transitively waits
   on. It does not require a job that waits on B: leaving that job out means it is not planned this
   time, which is what scoping a run is for.
3. **An incomplete selection is refused, not completed.** `SchedulingService.load_input` reports
   `unscheduled_prerequisite_job` naming each missing job, rather than adding them. Auto-expanding
   would return a schedule containing jobs the caller did not ask for.
4. **The manager's backlog expands the selection instead, client-side.**
   `GET /api/v1/jobs/dependency-graph` serves the whole cross-job edge list so the frontend can
   follow the same edges backwards and tick the prerequisites as the manager selects. The refusal in
   3 is then a guard on the contract, not the path a person is expected to travel.
5. **Refusals travel the existing `SchedulingIssue` path.** `unknown_job`, `empty_selection` and
   `unscheduled_prerequisite_job` are reported by the worker and surface through
   `GET /schedules/generations/{id}` as a `rejected` outcome, exactly as
   `unsupported_dependency_shape` already does. `SchedulingIssue` gains a `job_id` so a refusal
   names the row the backlog should mark.
6. **The selection is recorded on `schedule_job_selections`.** No rows means the run was unscoped.
   A scoped run always writes at least one row, because an empty selection is refused before
   generation, so the two cases never collide.

## Rationale

- Deriving rather than storing job-level edges keeps one source of truth. A cached job graph would
  need invalidating on every operation, dependency and job-definition write, and the derivation is a
  single indexed join over a table that currently holds 26 rows.
- Walking backwards only is the difference between scoping and not scoping. Following edges in both
  directions would pull in the entire weakly connected component, so one cross-job edge anywhere in
  the backlog would force every run that touches it to plan both sides.
- Refusing rather than auto-expanding keeps the response answering the request that was made. The
  frontend is not the only caller this API can have, and a caller that receives more jobs than it
  asked for has no way to tell that happened.
- Validating inside `load_input` rather than in the router puts the check in the transaction that
  already reads the dependency graph. `POST /schedules` touches no database at all today: it queues
  and returns 202. Adding a read there to fail faster would give the frontend two error shapes to
  handle for one kind of mistake.
- One derivation feeding both the endpoint and the refusal means the UI cannot prevent a different
  set of selections than the API enforces.

## Alternatives considered

- **Store job-level dependencies in their own table:** rejected. It duplicates a fact
  `dependencies` already holds, and every write path that touches operations would have to maintain
  it. #125 settled that precedence lives at operation level; this would quietly reopen that.
- **Auto-add the missing prerequisite jobs and schedule them:** rejected, per 3. It also makes
  `input_operation_count` and the recorded selection describe something the caller never requested.
- **Reject the selection at `POST /schedules` with a 422:** rejected, per 5. It would make the
  endpoint read the database and split one class of failure across two response shapes. The cost
  accepted is that an unknown job id takes a queue round trip to report.
- **Put `required_job_ids` on each row of `GET /jobs`:** rejected. That list is cursor-paginated, a
  job's prerequisites are not confined to its page, and computing a closure per row would walk the
  dependency graph once per job on every page read.
- **Filter machines to those the selected jobs can use:** rejected. A machine belongs to the floor,
  not a job, and dropping one could produce `no_compatible_machine` for an operation whose route was
  fine.
- **Derive the selection from `schedule_entries` instead of recording it:** rejected. The entries
  say which operations were placed, not which jobs were asked for, and the two differ whenever a
  selected job holds no schedulable work.

## Consequences

- `SchedulingService.load_input` now returns `SchedulingInput | SchedulingInputInvalid`. The worker
  matches on it and never runs inference on a refused selection.
- `SchedulingIssue` has a fifth field. It is appended, so the adapter's positional construction
  (`SchedulingIssue(code, message, operation_id, machine_id)`) is unchanged.
- `generate_schedule` takes a second argument. *(Since decision 0019 it is required; there is no
  whole-floor run for its absence to mean.)*
- A job named by any schedule's selection cannot be deleted (`ON DELETE RESTRICT`). In practice this
  rarely fires alone: a job whose operations reached a schedule is already undeletable through
  `schedule_entries.operation_id`.
- **Scoping lets a run avoid the shapes `ReSchedEngine` cannot take, which is more than it was
  asked to do.** The engine refuses fan-in (`unsupported_dependency_shape`, #216), and refusal is
  whole-input: one fan-in operation anywhere in the database makes the *entire floor* unschedulable.
  Scoping a run to jobs the engine can take is therefore the difference between generating something
  and generating nothing. Verified against the dev database: a scoped run of a straight-chain job
  (the shape `JobDefinitionService` builds) returns a real schedule, while the unscoped run over the
  same floor is rejected with ten `unsupported_dependency_shape` issues, because the seeded benchmark
  jobs are fan-in.
- The corollary is that a selection is not guaranteed schedulable just because it passes the checks
  here. Selecting a fan-in job is still refused, by the engine rather than by this decision, and that
  refusal carries no `job_id` to mark. Closing #216 (PR #254's exact solver handles general DAGs)
  removes that second class of refusal; nothing in this decision depends on when it lands.
