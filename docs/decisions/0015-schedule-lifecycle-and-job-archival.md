# Decision: Drafts are disposable, confirmed schedules are history, finished jobs are archived

## Date

2026-09-16

## Status

Accepted. Point 7 is superseded by decision 0018: an archived job is read-only and archiving is
one way.

## Context

A schedule entry points at the operation it planned, and `schedule_entries.operation_id` is
`ON DELETE RESTRICT` (see the deletion policy in `database-schema.md`). So once any schedule has
been generated over a job, the job and its operations cannot be deleted. Three services refused
first, to give a reason instead of an integrity error, and the job-definition save went further and
refused every edit to a scheduled job, not just removals (#258). On the dev floor every job became
read-only after one generation.

Two things made that worse than the policy intended. Generation writes its result as a draft, and
until this decision nothing could remove a draft, so a manager who generated one "to have a look"
had locked the jobs in it for good. And nothing let a job leave the backlog: a finished or cancelled
job stayed there and was handed to every later generation.

The alternative discussed was to give each schedule its own copy of the jobs and operations it
planned, so the originals could be freely deleted (#259). It was rejected: `schedule_entries` and
`schedule_dependencies` already snapshot every number that affects a schedule (machine, duration,
energy, salary, start time, and the precedence graph), so copying the rows they point at would be a
second source of truth for the same facts, and the simulation, the entries and the events would all
have to be repointed at the copies. The only thing a schedule reads live is a display name.

## Decision

1. **A draft schedule is disposable.** `DELETE /api/v1/schedules/{id}` removes a draft outright,
   with its entries, dependencies and job selections. It is a hard delete rather than a change to
   `status = 'discarded'`, because the FK on the entry rows blocks operation removal regardless of
   status, and a draft nobody confirmed is not a record of anything. `discarded` is reserved for a
   confirmed schedule that is later withdrawn.
2. **A confirmed schedule is history.** It cannot be deleted through the API, and a job or
   operation it planned cannot be deleted either. `simulations.schedule_id` RESTRICT is the
   database backstop.
3. **Edits to a scheduled job are always allowed; only removing a scheduled operation is refused.**
   Every other edit is covered by the schedule's own snapshot. This is the same position
   `DependencyService.replace_job_dependencies` already took for ordering edits.
4. **Every refusal names the schedules in the way, split by what the caller can do about them.**
   `draft_schedule_ids` can be deleted to clear the way; `confirmed_schedule_ids` cannot. The
   refusal never deletes drafts on the caller's behalf.
5. **A finished or cancelled job is archived, not deleted.** `jobs.archived_at` is set
   automatically for every job in a schedule whose simulation completes, or by hand through
   `PATCH /api/v1/jobs/{id}` with `archived: true`. Archived jobs are hidden from the backlog and
   skipped by a whole-floor generation; naming one in a scoped run is refused as `archived_job`.
   Archiving never makes a job deletable, and resetting a simulation does not un-archive its jobs.
6. **A precedence edge touching an archived job is treated as satisfied.** Both the job dependency
   graph the backlog reads and the input the scheduler loads drop such edges, so the backlog never
   auto-ticks a job the scheduler would then refuse.
7. *(Superseded by decision 0018.)* **Archiving takes a job out of the backlog; it does not freeze it.** An archived job can still
   be read and edited through every job, operation and definition endpoint. Blocking edits would
   add a refusal to four write paths for no user story: a cancelled job that comes back gets fixed
   and unarchived in whichever order the manager likes, and a finished job's record is protected
   by the confirmed schedule, not by the job row. The archived state is exposed on every job
   response so the builder can show it; hiding an archived job from the lists is what stops it
   being edited by accident.

## Rationale

- The distinction that matters is not "scheduled or not" but "did the floor act on it". A draft is
  a proposal; a confirmed schedule is an instruction. Deleting a proposal loses nothing; deleting an
  instruction rewrites what happened.
- Keeping pointers and the RESTRICT policy means old schedules stay replayable in the simulation
  with no extra columns, because nothing they point at can disappear. Archiving is what lets the
  backlog shrink without breaking that.
- Naming the blocking schedules turns a dead end into a workflow: the client can offer "delete
  these drafts and retry" exactly when that would work, and "archive instead" when it would not.

## Alternatives considered

- **Per-schedule copies of jobs and operations**: rejected, see Context.
- **Snapshot job and operation names onto `schedule_entries` and relax `operation_id` to
  `SET NULL`**: a smaller version of the same idea. It would let jobs be hard-deleted, but no case
  was found where deleting a job a confirmed schedule ran is what a manager actually wants; the
  real wants were "edit a job I have only drafted" (delete the draft) and "get a finished job out
  of the backlog" (archive). Kept as a fallback if hard deletion of run jobs is ever required.
- **Narrowing the guard alone (#258 as filed)**: correct but insufficient. Removal of a step
  drafted once would still be blocked forever, because nothing could remove the draft.
- **Deriving "archived" from schedule state instead of storing it**: a job is done when a
  confirmed schedule containing it has a completed simulation, which is derivable. It cannot
  express a cancelled job, it would un-finish a job the moment a step is added, and the backlog
  and scheduler would each need the three-table join on every read. The trigger is schedule-based;
  the state lives on the job.
- **Auto-deleting drafts when a job is deleted**: rejected as a hidden cascade of schedule
  deletion. The refusal names the drafts and the client deletes them explicitly.

## Consequences

- `JobIsScheduled`, `OperationIsScheduled` and `JobDefinitionIsScheduled` carry a
  `ScheduleReferences` and their 409s emit `draft_schedule_ids` and `confirmed_schedule_ids`.
- `ScheduleLifecycleService` is the home of post-generation transitions; the confirm transition
  (#246) belongs beside `delete_draft`, and both lock the schedule row so they cannot race.
- `SimulationService.record_control` archives the schedule's jobs on `COMPLETED`, in the same
  transaction as the event.
- The frontend follow-ups are a delete button for drafts on the scheduler page, reading the two id
  lists on the jobs page, and an archive toggle with an archived filter.
- Seeded benchmark schedules are confirmed, so seeded jobs remain undeletable on purpose.
