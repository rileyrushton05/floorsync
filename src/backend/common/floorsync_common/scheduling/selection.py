"""Refusals for a schedule run scoped to a chosen set of jobs (#231).

Pure and total, like `find_dependency_cycle`: it is handed what the database holds and returns what
is wrong with the selection, leaving the caller to decide what that means. The database reads that
feed it live in `SchedulingService.load_input`, which is the only place that knows the transaction.

Every refusal is a `SchedulingIssue`, which is how the adapter already reports an input it cannot
take, so a scoped run that is refused reaches the client through exactly the path
`unsupported_dependency_shape` and `no_compatible_machine` already use.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping
from typing import assert_never
from uuid import UUID

from floorsync_common.jobs.backlog import JobBacklog
from floorsync_common.jobs.dependency_graph import JobEdge, prerequisite_job_ids
from floorsync_common.scheduling.contracts import SchedulingIssue

UNKNOWN_JOB = "unknown_job"
"""The selection names a job that does not exist."""

EMPTY_SELECTION = "empty_selection"
"""The selection contains no job, or no job in it has an operation to schedule."""

UNSCHEDULED_PREREQUISITE_JOB = "unscheduled_prerequisite_job"
"""The selection leaves out a job that a selected job waits on."""

ARCHIVED_JOB = "archived_job"
"""The selection names a job a manager retired by hand."""

PLANNED_JOB = "planned_job"
"""The selection names a job a confirmed schedule already plans (or has already run)."""


def selection_issues(
    selected: Collection[UUID],
    *,
    known_job_ids: Collection[UUID],
    job_edges: Iterable[JobEdge],
    backlog: Mapping[UUID, JobBacklog],
) -> tuple[SchedulingIssue, ...]:
    """Report everything wrong with a job selection, before any of it reaches the scheduler.

    Unknown jobs are reported alone: a prerequisite walk over a selection containing ids that do not
    exist would report missing prerequisites for jobs the caller has already got wrong, which is
    noise. Jobs that have left the backlog likewise: an archived job was retired by hand, and a
    planned or done job is already claimed by a confirmed schedule (`backlog`, decision 0019), so
    asking to schedule either is a mistake in the request rather than a gap in it. Each issue
    names its job in `job_id`, a planned one names the schedule too, and issues are ordered by id
    so the same bad request always reads the same.
    """

    if not selected:
        return (
            SchedulingIssue(
                EMPTY_SELECTION,
                "Select at least one job to schedule.",
            ),
        )

    unknown = sorted(set(selected) - set(known_job_ids))
    if unknown:
        return tuple(
            SchedulingIssue(
                UNKNOWN_JOB,
                "No such job.",
                job_id=job_id,
            )
            for job_id in unknown
        )

    claimed = sorted(job_id for job_id in selected if backlog[job_id].status != "open")
    if claimed:
        return tuple(_claimed_issue(job_id, backlog[job_id]) for job_id in claimed)

    missing = sorted(prerequisite_job_ids(selected, job_edges) - set(selected))
    return tuple(
        SchedulingIssue(
            UNSCHEDULED_PREREQUISITE_JOB,
            "A selected job waits on this job, so it has to be scheduled too.",
            job_id=job_id,
        )
        for job_id in missing
    )


def _claimed_issue(job_id: UUID, backlog: JobBacklog) -> SchedulingIssue:
    match backlog.status:
        case "archived":
            return SchedulingIssue(
                ARCHIVED_JOB,
                "This job has been archived, so it is no longer offered for scheduling.",
                job_id=job_id,
            )
        case "done":
            return SchedulingIssue(
                PLANNED_JOB,
                "This job has already been run by a confirmed schedule.",
                job_id=job_id,
                schedule_id=backlog.schedule_ids[-1],
            )
        case "planned":
            return SchedulingIssue(
                PLANNED_JOB,
                "A confirmed schedule already plans this job; discard it to plan the job again.",
                job_id=job_id,
                schedule_id=backlog.schedule_ids[-1],
            )
        case "open":
            raise ValueError("An open job is not a claimed one.")
        case _:
            assert_never(backlog.status)


def no_schedulable_work_issue() -> SchedulingIssue:
    """The selection resolved to real jobs that between them hold no operation.

    Distinct from the adapter's `no_operations`, which means the whole floor is empty: here the
    floor may be busy and the *chosen* part of it is not, which is a mistake in the request rather
    than a reason to plan nothing.
    """

    return SchedulingIssue(
        EMPTY_SELECTION,
        "The selected jobs have no operations to schedule.",
    )
