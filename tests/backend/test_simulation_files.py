"""End-to-end checks of the benchmark file-reading path against real files.

`tests/backend/data/` holds a real benchmark instance (`abz5`, 10 jobs on 10
machines) and a feasible solution for it. The solution was produced by greedy
list scheduling rather than a solver, so its makespan of 1370 is valid but not
optimal — abz5's best known is 1234. That is deliberate: these tests check that a
schedule is read and resolved correctly, not that it is any good.

The makespan recorded in the solution file is the oracle. `TimelineBuilder`
recomputes timing independently from the instance's precedence and the file's
machine sequences, so agreement between the two is a real check rather than the
code confirming itself.
"""

from itertools import pairwise
from pathlib import Path

import pytest

from floorsync_common.simulation import (
    JobShopInstance,
    Schedule,
    SimulationEngine,
    Timeline,
    TimelineBuilder,
)
from floorsync_common.simulation.__main__ import (
    job_glyphs,
    main,
    render_gantt,
    render_machine_table,
    render_snapshot,
)

DATA = Path(__file__).parent / "data"
INSTANCE_PATH = DATA / "abz5.json"
SOLUTION_PATH = DATA / "solutions_greedy-spt_2026-09-06.json"

EXPECTED_MAKESPAN = 1370
EXPECTED_OPERATIONS = 100


@pytest.fixture(scope="module")
def timeline() -> Timeline:
    """Resolve the fixture instance and solution once for the whole module."""
    instance = JobShopInstance.load_from_json(INSTANCE_PATH)
    schedule = Schedule.load_from_json(SOLUTION_PATH, "abz5")
    return TimelineBuilder.build(instance, schedule)


def test_instance_file_parses() -> None:
    instance = JobShopInstance.load_from_json(INSTANCE_PATH)

    assert instance.name == "abz5"
    assert instance.family == "abz"
    assert instance.job_count == 10
    assert instance.machine_count == 10
    assert len(instance.operations) == EXPECTED_OPERATIONS
    assert instance.total_work == 7773


def test_solution_file_parses() -> None:
    schedule = Schedule.load_from_json(SOLUTION_PATH, "abz5")

    assert schedule.instance_name == "abz5"
    assert schedule.makespan == EXPECTED_MAKESPAN
    assert schedule.solver == "greedy-spt"
    assert len(schedule.machine_ids) == 10
    # Every machine runs all ten jobs exactly once in this instance.
    for machine_id in schedule.machine_ids:
        assert sorted(schedule.sequence_for_machine(machine_id)) == list(range(10))


def test_resolved_makespan_matches_the_recorded_one(timeline: Timeline) -> None:
    """The independent recomputation has to agree with the file."""
    assert timeline.makespan == EXPECTED_MAKESPAN
    assert len(timeline.operations) == EXPECTED_OPERATIONS


def test_no_machine_runs_two_operations_at_once(timeline: Timeline) -> None:
    for machine_key in timeline.machine_keys:
        for earlier, later in pairwise(timeline.operations_for_machine(machine_key)):
            assert earlier.end_time <= later.start_time


def test_every_job_runs_its_operations_in_order(timeline: Timeline) -> None:
    for job_key in timeline.job_keys:
        chain = sorted(timeline.operations_for_job(job_key), key=lambda item: item.start_time)
        assert len(chain) == 10
        for earlier, later in pairwise(chain):
            assert earlier.end_time <= later.start_time


def test_no_operation_loses_or_gains_duration(timeline: Timeline) -> None:
    instance = JobShopInstance.load_from_json(INSTANCE_PATH)

    assert sum(item.duration for item in timeline.operations) == instance.total_work
    for item in timeline.operations:
        assert item.end_time - item.start_time == item.duration


def test_engine_loads_both_files_and_plays_them() -> None:
    """The read-JSON path a caller actually uses."""
    engine = SimulationEngine()
    engine.load_instance(INSTANCE_PATH)
    resolved = engine.load_schedule(SOLUTION_PATH, "abz5")

    assert resolved.makespan == EXPECTED_MAKESPAN

    start = engine.seek(0)
    assert start.time == 0
    assert start.is_complete is False
    assert len(start.machines) == 10
    assert len(start.jobs) == 10

    middle = engine.seek(EXPECTED_MAKESPAN // 2)
    assert middle.active, "some machine should be busy halfway through"
    assert 0 < middle.progress < 1

    end = engine.seek(EXPECTED_MAKESPAN)
    assert end.is_complete is True
    assert end.active == ()
    assert all(job.status == "done" for job in end.jobs)


def test_playback_never_reports_more_active_operations_than_machines() -> None:
    """A machine can only run one operation at a time, at every instant sampled."""
    engine = SimulationEngine()
    engine.load_instance(INSTANCE_PATH)
    engine.load_schedule(SOLUTION_PATH, "abz5")

    for frame in engine.frames(step=50.0):
        assert len(frame.active) <= 10
        busy = {machine.machine_key for machine in frame.machines if machine.status == "busy"}
        assert len(frame.active) == len(busy)


# -- readable text output -------------------------------------------------


def test_gantt_draws_one_lane_per_machine(timeline: Timeline) -> None:
    chart = render_gantt(timeline, width=40)
    lines = chart.splitlines()

    assert len(lines) == 11, "an axis line plus one lane per machine"
    for line in lines[1:]:
        assert line.count("|") == 2
        assert len(line.split("|")[1]) == 40


def test_gantt_uses_one_glyph_per_job(timeline: Timeline) -> None:
    glyphs = job_glyphs(timeline)

    assert len(set(glyphs.values())) == 10
    assert set(glyphs.values()) <= set("0123456789")


def test_gantt_marks_idle_machine_time(timeline: Timeline) -> None:
    chart = render_gantt(timeline, width=60)

    assert "." in chart, "this schedule leaves machines idle, so gaps must show"


def test_machine_table_reports_a_row_per_machine(timeline: Timeline) -> None:
    table = render_machine_table(timeline)

    assert len(table.splitlines()) == 12, "header, rule, ten machines"
    assert "util" in table


def test_snapshot_describes_one_instant() -> None:
    engine = SimulationEngine()
    engine.load_instance(INSTANCE_PATH)
    engine.load_schedule(SOLUTION_PATH, "abz5")

    text = render_snapshot(engine, 700)

    assert "t = 700 of 1370" in text
    assert "jobs:" in text


def test_cli_prints_a_chart_and_confirms_the_recorded_makespan(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main([str(INSTANCE_PATH), str(SOLUTION_PATH), "--width", "40"])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "abz5" in output
    assert "matches the 1370 recorded" in output


def test_cli_reports_a_missing_file_without_a_traceback(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main([str(INSTANCE_PATH), "/does/not/exist.json"])

    assert exit_code == 1
    assert "error:" in capsys.readouterr().err
