# Decision: An archived job is read-only, and archiving is one way

## Date

2026-09-18

## Status

Accepted. Supersedes point 7 of decision 0015.

## Context

Decision 0015 gave a job a way to leave the backlog without being deleted: `jobs.archived_at`,
set when a simulation of a schedule that planned the job completes, or by hand. Point 7 of that
decision chose not to freeze an archived job. Every job, operation and definition endpoint kept
accepting edits, on the argument that no user story asked for a freeze, that a cancelled job which
comes back can be fixed and unarchived in either order, and that a finished job's record is
protected by the confirmed schedule rather than by the job row.

The jobs page has since given archived jobs a workflow (#265): an archived job is shown read-only,
and "Duplicate" is offered as the way to make changes. That is a business rule about persisted
data, and `docs/frontend-architecture.md` is explicit that the backend is the authority on every
such rule and the browser must not be a second gate. As things stood, the page promised a rule the
API did not have: anything that could reach the API could edit an archived job.

## Decision

1. **Every write that changes what a job is refuses while `archived_at` is set.** The paths are
   `PATCH /api/v1/jobs/{id}` for any field other than `archived`, `PUT /api/v1/jobs/{id}/definition`,
   `POST /api/v1/jobs/{id}/operations`, `PATCH` and `DELETE /api/v1/operations/{id}`, and
   `PUT /api/v1/jobs/{id}/dependencies`. Each service returns `JobIsArchived(job_id, archived_at)`
   before reading anything else or writing anything, and each route renders it as the one
   problem type `urn:floorsync:problem:job-is-archived` (409) with `job_id` and `archived_at` as
   extension members.
2. **Archiving is one way.** `PATCH` accepts only `archived: true`; there is no `archived: false`.
   A repeated `archived: true` on an archived job stays an idempotent no-op rather than a
   refusal, so a stale form does not error. `archived_at` therefore means one thing: a manager
   retired this job by hand. A job that a plan has claimed is not archived at all; its place in
   the backlog is derived from the schedules that reference it (#269), and it returns to the
   backlog when that plan is discarded, not through this endpoint.
3. **Reading, deleting and scheduling are unchanged.** An archived job can still be read through
   every endpoint that exposes it. Deletion keeps 0015's rules: a job a schedule planned cannot
   be deleted, archived or not, and a hand-archived job no schedule ever touched still can be.
   Whole-floor generation still skips archived jobs and a scoped run naming one is still refused.
4. **Machine capabilities are out of scope.** `PUT`/`DELETE /api/v1/machines/{id}/capabilities/{operation_id}`
   can add or remove a route for an archived job's operation from the machine side. It is left
   alone here because the machines feature is being changed in an open pull request (#264); it
   should take the same refusal in a follow-up.

## Rationale

The rule now exists because the product has one. A frontend affordance that the API does not
back is the "second gate" the frontend conventions forbid, and the cheapest way to close the gap
is in the four services that own the writes, using the same shape (`ExpectedOutcome`, result
union, `match` with `assert_never`, one problem type) the scheduled-job refusals already use.
Point 7's argument that a returning job can be fixed "in whichever order the manager likes" no
longer applies: a job comes back by duplicating it, which is the flow the jobs page offers. That
keeps the archived job's record exactly as it was.

## Alternatives considered

- **Drop the read-only rendering instead.** Keeps 0015 point 7 and asks the jobs page to make
  archived jobs editable. Rejected because the duplicate-to-change flow is the one the team wants
  for finished work, and a finished job's definition changing under its schedule's name is
  confusing even if the schedule's own snapshot is safe.
- **Refuse deletion of archived jobs too.** Rejected: a cancelled job that was archived by hand
  and never scheduled is exactly the case deletion is for, and a scheduled one is already
  protected.
- **Keep `archived: false` as the way back.** Cheap, and it would let a mis-click be undone.
  Rejected because no page needs it, "archived means gone, duplicate to continue" is one rule
  instead of two, and the job a manager most wants back (one a plan claimed) was never archived
  in the first place under #269.
- **Refuse `PATCH archived: true` with other fields.** Simpler guard, but it turns a harmless
  repeated archive request with a stale form into an error. Rejected in favour of refusing only
  when a non-`archived` field is present.

## Consequences

- `JobIsArchived` in `floorsync_common.jobs.results`, carried by `UpdateJobResult`,
  `ReplaceDefinitionResult`, `CreateOperationResult`, `UpdateOperationResult`,
  `DeleteOperationResult` and `ReplaceJobDependenciesResult`. `job_is_archived_problem` in
  `floorsync_api.problems` renders it.
- The jobs page can keep its read-only rendering as an affordance and report the 409 if a stale
  tab tries anyway.
- A mis-archived job cannot be un-archived through the API; the recovery is Duplicate. Adding
  `archived: false` back later is a small change if that ever proves wrong.
- Point 7 of decision 0015 is superseded; the rest of 0015 stands.
- Follow-up: the machine capability endpoints (decision 4) once #264 lands.
