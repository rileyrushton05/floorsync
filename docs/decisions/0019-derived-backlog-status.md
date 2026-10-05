# Decision: A job's place in the backlog is derived from its schedules, never stored on it

## Date

2026-09-19

## Status

Accepted. Amends decision 0015 points 5 and 6 and decision 0013 (the whole-floor run).

Point 4 amended 2026-10-05: a `planned` job may be selected again, so a manager can draft an
alternative to a confirmed plan. Only `archived` (`archived_job`) and `done` (`planned_job`) jobs
are refused. The job dependency graph still treats edges into planned jobs as satisfied.

## Context

The backlog is the work no plan has claimed. Once a manager can confirm a schedule (#268), a job
in that schedule should leave the backlog, come back if the schedule is withdrawn, and read as
finished once the schedule's simulation completes. Two ways to get there were on the table.

The first (#266) stamps `jobs.archived_at` when a schedule is confirmed, clears it when the
schedule is discarded unless another confirmed schedule still plans the job, stamps it again on
restore, and has the seed loader stamp it for seeded schedules. Four write paths keep one column
honest, and the column ends up meaning three different things: cancelled by hand, claimed by a
plan, and ran.

The second reads the answer from where it is already written. `schedule_entries` says which
schedule plans which operation, `schedules.status` says whether that plan is confirmed, and
`simulations.status` says whether it ran. The "clear it unless another plan still has it" rule in
the first option is exactly this query, run at write time to cache it in a column.

## Decision

1. **`archived_at` means one thing: a manager retired the job by hand.** Nothing else writes it.
   Simulation completion no longer archives the schedule's jobs (0015 point 5 amended).
2. **Every job response carries `backlog_status`**, derived at read time by
   `floorsync_common.jobs.backlog`: `open` (no confirmed schedule plans it), `planned` (at least
   one does), `done` (one of those schedules has a completed simulation), `archived`
   (`archived_at` is set). `archived` wins because it is the manager's explicit word; `done` wins
   over `planned` because the floor having run the work is the stronger fact.
   `planned_by_schedule_ids` lists the confirmed schedules that plan the job, oldest first.
3. **Drafts and discarded schedules claim nothing.** A draft is a proposal; a discarded schedule
   was withdrawn. So generating a draft to have a look changes no job's status, and discarding a
   plan puts its jobs back in the backlog with no job row touched.
4. **Generation refuses a job that has left the backlog, whatever the reason.** `archived_job`
   for a hand-archived job, `planned_job` (naming the schedule in `schedule_id`) for a planned or
   done one. The validation endpoint reports the same. The job dependency graph and the loaded
   input treat an edge into any such job as satisfied (0015 point 6 extended).
5. **A run always names its jobs.** `job_ids` is required, with at least one entry, on
   `POST /api/v1/schedules` and `GET /api/v1/schedules/validation` (#270). The whole-floor run
   decision 0013 allowed for an omitted selection is gone: the backlog page is the one place that
   decides what a run contains, and "everything open" is a selection it can make explicitly.
6. **One read, in bulk.** `BacklogService.load` answers any number of jobs with one statement.
   Routes call it after the job service inside the same transaction; a job created a moment ago
   is reported `open` without a read, since nothing can have planned it yet.
7. **Only an open job can be changed.** Decision 0018 made archived jobs read-only; this widens
   it to planned and done jobs, since editing a job after a plan has committed to it makes the
   job and its plan disagree, and the edit could never be scheduled anyway (the job is refused
   as `planned_job` until the plan is discarded). Every write path calls `refuse_unless_open`
   (`jobs/guards.py`) first and returns `JobHasLeftBacklog`; the one write a non-open job still
   takes is `archived: true`, which is how a manager cancels a planned job. A job in a draft is
   still open, so generating a schedule to look at it locks nothing.

## Rationale

This is the same argument decision 0011 lost and decision 0015 won: store what a person decided,
derive what follows from it. Confirm, discard and restore become status changes on the schedule
with no job bookkeeping, the seed loader needs nothing, and "two confirmed schedules plan the same
job" is simply a job with two ids in `planned_by_schedule_ids` rather than a special case for the
un-archive rule. Requiring `job_ids` removes a whole code path (`load_input`, `selection.py`,
`validate_floor` and both worker tasks all lose their unscoped branch) for a feature no page used.

## Alternatives considered

- **Archive on confirm (#266 as first agreed).** Rejected for the reasons in Context: four
  places to keep a column true, and a column with three meanings. A `jobs.archived_reason`
  would have patched the un-archive rule but not the duplication.
- **Archive on generation with archived jobs still schedulable (#266 as written).** Rejected:
  a finished job would be re-planned by every run, and generating a draft to look at would empty
  the backlog, which 0015 had just fixed.
- **Filter the job lists by `backlog_status` server-side.** Deferred: the backlog page fetches
  every page and filters locally, and cursor pagination over a derived column needs its own
  design. The field is enough for now.

## Consequences

- `floorsync_common.jobs.backlog`: `BacklogStatus`, `JobBacklog`, `derive_backlog`,
  `planned_jobs_statement`, `planned_job_ids_statement`, `BacklogService`. Pure except the
  statement builders and the service; imports models only.
- `JobResponse`, `JobDetailResponse` and `JobDefinitionResponse` gain `backlog_status` and
  `planned_by_schedule_ids`. `SchedulingIssue` and its response gain `schedule_id`.
- `JobIsArchived` (decision 0018) becomes `JobHasLeftBacklog(job_id, backlog, archived_at)`, and
  the problem type `job-is-archived` becomes `job-has-left-backlog` with `backlog_status` and
  `planned_by_schedule_ids` as extension members. The frontend keys read-only on
  `backlog_status !== "open"`.
- `JobService.archive_scheduled_jobs` is removed, along with the completion write in
  `SimulationService.record_control`.
- `SchedulingService.load_input`, `store_draft`, `ValidationService.validate_floor` and the two
  worker tasks take a required `job_ids`. A task queued without one fails loudly rather than
  planning the whole floor.
- Schedule status constants now live beside their check constraint in
  `database/models/schedule.py` (and simulation's in `models/simulation.py`); `references.py`
  and `simulation/service.py` read them from there.
- The frontend's planner sends no `job_ids` today, so Generate on that page answers 422 until
  #271 passes the ticked jobs through. `backlog_status` is additive; nothing else changes shape.
- A one-operation job crashes the ReSched engine (`argmax` over an empty dimension) before any
  of this runs; found while verifying, unrelated, needs its own ticket.
