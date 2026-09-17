"""Coverage for scoping a schedule run to a chosen set of jobs (#231).

The graph walk and the refusals are pure, so they are tested directly on the values the database
would supply. The filtering in `SchedulingService.load_input` is the part that is SQL rather than
logic, and this repository has no real-database test fixture; it was run against the real dev
Postgres by hand, per docs/database-conventions.md. See the pull request.
"""

from uuid import UUID, uuid4

from floorsync_common.jobs.dependency_graph import prerequisite_job_ids
from floorsync_common.scheduling.selection import (
    ARCHIVED_JOB,
    EMPTY_SELECTION,
    UNKNOWN_JOB,
    UNSCHEDULED_PREREQUISITE_JOB,
    selection_issues,
)


def _ids(count: int) -> list[UUID]:
    return [uuid4() for _ in range(count)]


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

    assert (
        selection_issues(
            [before, after], known_job_ids=[before, after], job_edges=[(before, after)]
        )
        == ()
    )


def test_selecting_nothing_is_refused() -> None:
    """An empty list selects nothing; it is not the same as omitting the selection entirely."""

    (issue,) = selection_issues([], known_job_ids=_ids(2), job_edges=[])

    assert issue.code == EMPTY_SELECTION
    assert issue.job_id is None


def test_an_unknown_job_is_refused_and_named() -> None:
    known, unknown = _ids(2)

    (issue,) = selection_issues([known, unknown], known_job_ids=[known], job_edges=[])

    assert issue.code == UNKNOWN_JOB
    assert issue.job_id == unknown


def test_unknown_jobs_are_reported_without_a_prerequisite_walk() -> None:
    """Complaining about a prerequisite of a job the caller got wrong is noise, not information."""

    known, unknown, prerequisite = _ids(3)

    issues = selection_issues(
        [known, unknown],
        known_job_ids=[known, prerequisite],
        job_edges=[(prerequisite, known)],
    )

    assert {issue.code for issue in issues} == {UNKNOWN_JOB}


def test_an_archived_job_is_refused_and_named() -> None:
    """An archived job exists but has left the backlog, so selecting it is a mistake, not a gap."""

    open_job, archived = _ids(2)

    (issue,) = selection_issues(
        [open_job, archived],
        known_job_ids=[open_job, archived],
        archived_job_ids=[archived],
        job_edges=[],
    )

    assert issue.code == ARCHIVED_JOB
    assert issue.job_id == archived


def test_archived_jobs_are_reported_without_a_prerequisite_walk() -> None:
    open_job, archived, prerequisite = _ids(3)

    issues = selection_issues(
        [open_job, archived],
        known_job_ids=[open_job, archived, prerequisite],
        archived_job_ids=[archived],
        job_edges=[(prerequisite, open_job)],
    )

    assert {issue.code for issue in issues} == {ARCHIVED_JOB}


def test_a_missing_prerequisite_is_refused_and_named() -> None:
    prerequisite, selected = _ids(2)

    (issue,) = selection_issues(
        [selected],
        known_job_ids=[prerequisite, selected],
        job_edges=[(prerequisite, selected)],
    )

    assert issue.code == UNSCHEDULED_PREREQUISITE_JOB
    assert issue.job_id == prerequisite


def test_a_selection_missing_a_downstream_job_is_accepted() -> None:
    """Refusing this would make scoping useless: every run would have to include the whole chain."""

    selected, downstream = _ids(2)

    assert (
        selection_issues(
            [selected],
            known_job_ids=[selected, downstream],
            job_edges=[(selected, downstream)],
        )
        == ()
    )


def test_every_missing_prerequisite_is_reported_at_once() -> None:
    """One round trip per missing job would be a miserable way to fix a selection."""

    first, second, selected = _ids(3)

    issues = selection_issues(
        [selected],
        known_job_ids=[first, second, selected],
        job_edges=[(first, selected), (second, selected)],
    )

    assert {issue.job_id for issue in issues} == {first, second}
    assert {issue.code for issue in issues} == {UNSCHEDULED_PREREQUISITE_JOB}


def test_the_same_bad_selection_always_reads_the_same() -> None:
    """Issues are ordered by id, so a client is not diffing a set that arrives shuffled."""

    first, second, selected = _ids(3)
    edges = [(first, selected), (second, selected)]

    issues = selection_issues([selected], known_job_ids=[first, second, selected], job_edges=edges)
    reversed_inputs = selection_issues(
        [selected], known_job_ids=[selected, second, first], job_edges=list(reversed(edges))
    )

    assert [issue.job_id for issue in issues] == sorted([first, second])
    assert issues == reversed_inputs
