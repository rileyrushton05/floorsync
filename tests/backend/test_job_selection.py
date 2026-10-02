"""Coverage for scoping a schedule run to a chosen set of jobs (#231).

The graph walk and the refusals are pure, so they are tested directly on the values the database
would supply. The filtering in `SchedulingService.load_input` is the part that is SQL rather than
logic, and this repository has no real-database test fixture; it was run against the real dev
Postgres by hand, per docs/database-conventions.md. See the pull request.
"""

from collections.abc import Collection, Iterable, Mapping
from datetime import UTC, datetime
from uuid import UUID, uuid4

from floorsync_common.jobs.backlog import JobBacklog
from floorsync_common.jobs.dependency_graph import JobEdge, prerequisite_job_ids
from floorsync_common.scheduling.contracts import SchedulingIssue
from floorsync_common.scheduling.selection import (
    ARCHIVED_JOB,
    EMPTY_SELECTION,
    PLANNED_JOB,
    UNKNOWN_JOB,
    UNSCHEDULED_PREREQUISITE_JOB,
    selection_issues,
)

ARCHIVED_AT = datetime(2026, 9, 18, tzinfo=UTC)


def _ids(count: int) -> list[UUID]:
    return [uuid4() for _ in range(count)]


def _backlog(
    known: Iterable[UUID],
    *,
    archived: Collection[UUID] = (),
    planned: Mapping[UUID, UUID] | None = None,
    done: Mapping[UUID, UUID] | None = None,
) -> dict[UUID, JobBacklog]:
    """Every known job is open unless named as archived, planned by, or done by a schedule."""

    planned = planned or {}
    done = done or {}
    backlog: dict[UUID, JobBacklog] = {}
    for job_id in known:
        if job_id in archived:
            backlog[job_id] = JobBacklog(status="archived", schedule_ids=())
        elif job_id in done:
            backlog[job_id] = JobBacklog(status="done", schedule_ids=(done[job_id],))
        elif job_id in planned:
            backlog[job_id] = JobBacklog(status="planned", schedule_ids=(planned[job_id],))
        else:
            backlog[job_id] = JobBacklog(status="open", schedule_ids=())
    return backlog


def _issues(
    selected: Collection[UUID],
    known: Collection[UUID],
    edges: Iterable[JobEdge] = (),
    *,
    archived: Collection[UUID] = (),
    planned: Mapping[UUID, UUID] | None = None,
    done: Mapping[UUID, UUID] | None = None,
) -> tuple[SchedulingIssue, ...]:
    return selection_issues(
        selected,
        known_job_ids=known,
        job_edges=edges,
        backlog=_backlog(known, archived=archived, planned=planned, done=done),
    )


# -- the walk ----------------------------------------------------------------


def test_a_selection_with_no_cross_job_edges_requires_only_itself() -> None:
    """The case every FloorSync database is in today: no cross-job edge exists."""

    first, second = _ids(2)

    assert prerequisite_job_ids([first], []) == frozenset({first})
    assert prerequisite_job_ids([first, second], []) == frozenset({first, second})


def test_selecting_a_job_pulls_in_what_it_waits_on() -> None:
    before, after = _ids(2)

    assert prerequisite_job_ids([after], [(before, after)]) == frozenset({before, after})


def test_selecting_a_job_does_not_pull_in_what_waits_on_it() -> None:
    """The asymmetry the whole feature turns on.

    A job downstream of the selection does not have to be planned with it: leaving it out simply
    means it is not scheduled this time, which is exactly what scoping a run is for. Walking both
    directions would scope every run to the entire connected component.
    """

    before, after = _ids(2)

    assert prerequisite_job_ids([before], [(before, after)]) == frozenset({before})


def test_prerequisites_are_followed_all_the_way_back() -> None:
    """Transitive, not one hop: the job a prerequisite waits on is required just as much."""

    first, second, third = _ids(3)
    edges = [(first, second), (second, third)]

    assert prerequisite_job_ids([third], edges) == frozenset({first, second, third})


def test_a_diamond_reports_each_job_once() -> None:
    """Fan-in at the job level: two prerequisites sharing one of their own."""

    root, left, right, merge = _ids(4)
    edges = [(root, left), (root, right), (left, merge), (right, merge)]

    assert prerequisite_job_ids([merge], edges) == frozenset({root, left, right, merge})


def test_the_walk_terminates_on_a_cycle() -> None:
    """Cycles are refused at write time by `find_dependency_cycle`; this must not rely on that."""

    first, second = _ids(2)

    assert prerequisite_job_ids([first], [(first, second), (second, first)]) == frozenset(
        {first, second}
    )


def test_an_unrelated_component_is_left_alone() -> None:
    selected, unrelated_before, unrelated_after = _ids(3)

    assert prerequisite_job_ids([selected], [(unrelated_before, unrelated_after)]) == frozenset(
        {selected}
    )


# -- the refusals ------------------------------------------------------------


def test_a_complete_selection_is_accepted() -> None:
    before, after = _ids(2)

    assert _issues([before, after], [before, after], [(before, after)]) == ()


def test_selecting_nothing_is_refused() -> None:
    """An empty list selects nothing, and a selection is required (#270)."""

    (issue,) = _issues([], _ids(2))

    assert issue.code == EMPTY_SELECTION
    assert issue.job_id is None


def test_an_unknown_job_is_refused_and_named() -> None:
    known, unknown = _ids(2)

    (issue,) = _issues([known, unknown], [known])

    assert issue.code == UNKNOWN_JOB
    assert issue.job_id == unknown


def test_unknown_jobs_are_reported_without_a_prerequisite_walk() -> None:
    """Complaining about a prerequisite of a job the caller got wrong is noise, not information."""

    known, unknown, prerequisite = _ids(3)

    issues = _issues([known, unknown], [known, prerequisite], [(prerequisite, known)])

    assert {issue.code for issue in issues} == {UNKNOWN_JOB}


def test_an_archived_job_is_refused_and_named() -> None:
    """An archived job exists but has left the backlog, so selecting it is a mistake, not a gap."""

    open_job, archived = _ids(2)

    (issue,) = _issues([open_job, archived], [open_job, archived], archived=[archived])

    assert issue.code == ARCHIVED_JOB
    assert issue.job_id == archived
    assert issue.schedule_id is None


def test_a_planned_job_is_refused_and_names_the_schedule() -> None:
    """A confirmed schedule already claims it (decision 0019); the way to plan it again is to
    discard that schedule, so the refusal says which one."""

    open_job, planned, schedule = _ids(3)

    (issue,) = _issues([open_job, planned], [open_job, planned], planned={planned: schedule})

    assert issue.code == PLANNED_JOB
    assert issue.job_id == planned
    assert issue.schedule_id == schedule


def test_a_done_job_is_refused_the_same_way() -> None:
    done, schedule = _ids(2)

    (issue,) = _issues([done], [done], done={done: schedule})

    assert issue.code == PLANNED_JOB
    assert issue.schedule_id == schedule
    assert "already been run" in issue.message


def test_claimed_jobs_are_reported_without_a_prerequisite_walk() -> None:
    open_job, archived, planned, prerequisite, schedule = _ids(5)

    issues = _issues(
        [open_job, archived, planned],
        [open_job, archived, planned, prerequisite],
        [(prerequisite, open_job)],
        archived=[archived],
        planned={planned: schedule},
    )

    assert {issue.code for issue in issues} == {ARCHIVED_JOB, PLANNED_JOB}
    assert [issue.job_id for issue in issues] == sorted([archived, planned])


def test_a_missing_prerequisite_is_refused_and_named() -> None:
    prerequisite, selected = _ids(2)

    (issue,) = _issues([selected], [prerequisite, selected], [(prerequisite, selected)])

    assert issue.code == UNSCHEDULED_PREREQUISITE_JOB
    assert issue.job_id == prerequisite


def test_a_selection_missing_a_downstream_job_is_accepted() -> None:
    """Refusing this would make scoping useless: every run would have to include the whole chain."""

    selected, downstream = _ids(2)

    assert _issues([selected], [selected, downstream], [(selected, downstream)]) == ()


def test_every_missing_prerequisite_is_reported_at_once() -> None:
    """One round trip per missing job would be a miserable way to fix a selection."""

    first, second, selected = _ids(3)

    issues = _issues([selected], [first, second, selected], [(first, selected), (second, selected)])

    assert {issue.job_id for issue in issues} == {first, second}
    assert {issue.code for issue in issues} == {UNSCHEDULED_PREREQUISITE_JOB}


def test_the_same_bad_selection_always_reads_the_same() -> None:
    """Issues are ordered by id, so a client is not diffing a set that arrives shuffled."""

    first, second, selected = _ids(3)
    edges = [(first, selected), (second, selected)]

    issues = _issues([selected], [first, second, selected], edges)
    reversed_inputs = _issues([selected], [selected, second, first], list(reversed(edges)))

    assert [issue.job_id for issue in issues] == sorted([first, second])
    assert issues == reversed_inputs
