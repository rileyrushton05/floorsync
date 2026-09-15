"""Refusals for a schedule run scoped to a chosen set of jobs (#231).

Pure and total, like `find_dependency_cycle`: it is handed what the database holds and returns what
is wrong with the selection, leaving the caller to decide what that means. The database reads that
feed it live in `SchedulingService.load_input`, which is the only place that knows the transaction.

Every refusal is a `SchedulingIssue`, which is how the adapter already reports an input it cannot
take, so a scoped run that is refused reaches the client through exactly the path
`unsupported_dependency_shape` and `no_compatible_machine` already use.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable
from uuid import UUID

from floorsync_common.jobs.dependency_graph import JobEdge, prerequisite_job_ids
from floorsync_common.scheduling.contracts import SchedulingIssue

UNKNOWN_JOB = "unknown_job"
"""The selection names a job that does not exist."""

EMPTY_SELECTION = "empty_selection"
"""The selection contains no job, or no job in it has an operation to schedule."""

UNSCHEDULED_PREREQUISITE_JOB = "unscheduled_prerequisite_job"
"""The selection leaves out a job that a selected job waits on."""


def selection_issues(
    selected: Collection[UUID],
    *,
    known_job_ids: Collection[UUID],
    job_edges: Iterable[JobEdge],
) -> tuple[SchedulingIssue, ...]:
    """Report everything wrong with a job selection, before any of it reaches the scheduler.

    Unknown jobs are reported alone: a prerequisite walk over a selection containing ids that do not
    exist would report missing prerequisites for jobs the caller has already got wrong, which is
    noise. Each issue names its job in `job_id` so a client can mark the offending row rather than
    parse the message, and issues are ordered by id so the same bad request always reads the same.
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

    missing = sorted(prerequisite_job_ids(selected, job_edges) - set(selected))
    return tuple(
        SchedulingIssue(
            UNSCHEDULED_PREREQUISITE_JOB,
            "A selected job waits on this job, so it has to be scheduled too.",
            job_id=job_id,
        )
        for job_id in missing
    )


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
