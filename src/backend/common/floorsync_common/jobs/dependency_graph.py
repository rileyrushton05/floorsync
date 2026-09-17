"""The job-level view of operation precedence, derived rather than stored.

`dependencies` joins operations and never jobs, on purpose (see `dependency.py`): precedence is an
operation-level fact, and there is deliberately no `job_dependencies` table. A job-level edge is
therefore something this module *derives* -- it exists wherever one edge's two operations belong to
different jobs.

Everything here is pure except the one statement builder, so the same logic answers both callers:
the API, which tells the manager's backlog what ticking a job implies, and the scheduling service,
which refuses a selection that leaves a prerequisite out. Two call sites, one rule, no drift
between what the UI prevents and what the API enforces.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable
from uuid import UUID

from sqlalchemy import Select, select
from sqlalchemy.orm import aliased

from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.operation import Operation

type JobEdge = tuple[UUID, UUID]
"""One derived job-level edge: the `before` job must finish before the `after` job starts."""


def job_dependency_edges_statement() -> Select[JobEdge]:
    """Select every distinct cross-job edge between open jobs, as (before_job_id, after_job_id).

    Edges inside a single job are excluded: they order that job's own steps and say nothing about
    whether some *other* job has to be scheduled alongside it. Edges touching an archived job are
    excluded too: an archived prerequisite has finished or been cancelled and cannot be scheduled,
    so it is treated as satisfied rather than demanded, and an archived dependant is nobody's
    concern. Both callers need that same reading, or the backlog would auto-tick a job the
    scheduler then refuses. Ordered so two calls agree, which matters for a response body a client
    may diff.
    """

    before = aliased(Operation)
    after = aliased(Operation)
    before_job = aliased(Job)
    after_job = aliased(Job)
    return (
        select(before.job_id, after.job_id)
        .select_from(Dependency)
        .join(before, before.id == Dependency.before_operation_id)
        .join(after, after.id == Dependency.after_operation_id)
        .join(before_job, before_job.id == before.job_id)
        .join(after_job, after_job.id == after.job_id)
        .where(
            before.job_id != after.job_id,
            before_job.archived_at.is_(None),
            after_job.archived_at.is_(None),
        )
        .distinct()
        .order_by(before.job_id, after.job_id)
    )


def prerequisite_job_ids(
    selected: Collection[UUID],
    edges: Iterable[JobEdge],
) -> frozenset[UUID]:
    """Every job that has to be scheduled for `selected` to be schedulable, selection included.

    Walks the graph *backwards* only, and that asymmetry is the whole point. If job B waits on job
    A, scheduling B without A leaves B with nothing to start after, so A is pulled in. If job C
    waits on B, scheduling B without C is perfectly fine -- C simply is not planned this time.
    Following both directions would drag in the entire weakly connected component and scope a run
    to jobs nothing in the selection actually requires.

    Total: a cycle among jobs terminates on the `already required` check rather than looping. Cycles
    are refused at write time by `find_dependency_cycle`, but this must not depend on that.
    """

    waits_on: dict[UUID, list[UUID]] = {}
    for before, after in edges:
        waits_on.setdefault(after, []).append(before)

    required = set(selected)
    pending = list(required)
    while pending:
        for prerequisite in waits_on.get(pending.pop(), ()):
            if prerequisite not in required:
                required.add(prerequisite)
                pending.append(prerequisite)
    return frozenset(required)
