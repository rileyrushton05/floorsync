"""Tests for the schedule playback simulation package."""

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest

from floorsync_common.simulation import (
    CyclicScheduleError,
    FloorSyncScheduleAdapter,
    InstanceFormatError,
    JobShopInstance,
    JobStatus,
    MachineStatus,
    PlaybackClock,
    PrecedenceEdge,
    PrecedenceReason,
    Schedule,
    ScheduleDependencyRecord,
    ScheduleEntryRecord,
    ScheduleFormatError,
    ScheduleMismatchError,
    SimulationEngine,
    SimulationError,
    SimulationEventRecord,
    SimulationEventType,
    SimulationSnapshot,
    SimulationTimelineError,
    Timeline,
    TimelineBuilder,
    TimelineNode,
    derive_simulated_time,
    events_from_rows,
    resolve_start_times,
)

# Two jobs crossing two machines. Resolved by hand:
#   job 0 op 0  machine 0  duration 3   ->  0..3
#   job 1 op 0  machine 1  duration 4   ->  0..4
#   job 1 op 1  machine 0  duration 1   ->  4..5   (waits on its own job)
#   job 0 op 1  machine 1  duration 2   ->  4..6   (waits on machine 1)
# Makespan 6.
SIMPLE_INSTANCE: dict[str, Any] = {
    "instance": "simple",
    "family": "test",
    "machines": 2,
    "jobs": 2,
    "data": [
        {"job": 0, "operation": 0, "machine": 0, "duration": 3},
        {"job": 0, "operation": 1, "machine": 1, "duration": 2},
        {"job": 1, "operation": 0, "machine": 1, "duration": 4},
        {"job": 1, "operation": 1, "machine": 0, "duration": 1},
    ],
}
SIMPLE_SCHEDULE: dict[str, Any] = {
    "instance": "simple",
    "makespan": 6,
    "solver": "hand",
    "date": "2026-08-30",
    "machine_0": [0, 1],
    "machine_1": [1, 0],
}

# Job 0 visits machine 0 twice, so machine 0's sequence names job 0 twice.
#   job 0 op 0  machine 0  duration 2   ->  0..2
#   job 0 op 1  machine 1  duration 3   ->  2..5
#   job 1 op 0  machine 0  duration 4   ->  2..6
#   job 0 op 2  machine 0  duration 1   ->  6..7
# Makespan 7.
REENTRANT_INSTANCE: dict[str, Any] = {
    "instance": "reentrant",
    "family": "test",
    "machines": 2,
    "jobs": 2,
    "data": [
        {"job": 0, "operation": 0, "machine": 0, "duration": 2},
        {"job": 0, "operation": 1, "machine": 1, "duration": 3},
        {"job": 0, "operation": 2, "machine": 0, "duration": 1},
        {"job": 1, "operation": 0, "machine": 0, "duration": 4},
    ],
}
REENTRANT_SCHEDULE: dict[str, Any] = {
    "instance": "reentrant",
    "makespan": 7,
    "machine_0": [0, 1, 0],
    "machine_1": [0],
}

START = datetime(2026, 9, 5, 8, 0, tzinfo=UTC)


def build(instance_doc: dict[str, Any], schedule_doc: dict[str, Any]) -> Timeline:
    """Parse both benchmark documents and resolve them into a timeline."""
    return TimelineBuilder.build(
        JobShopInstance.from_dict(instance_doc), Schedule.from_dict(schedule_doc)
    )


def placement(timeline: Timeline) -> dict[tuple[str, str], tuple[int, int]]:
    """Return each operation's resolved interval, keyed by job and step label."""
    return {
        (item.job_label, item.operation_label): (item.start_time, item.end_time)
        for item in timeline.operations
    }


def assert_no_machine_overlap(timeline: Timeline) -> None:
    """Assert no machine processes two operations at once."""
    for machine_key in timeline.machine_keys:
        for earlier, later in pairwise(timeline.operations_for_machine(machine_key)):
            assert earlier.end_time <= later.start_time


def node(key: str, duration: int, *, job: str = "j", machine: str = "m") -> TimelineNode:
    """Build a bare node for core-level tests."""
    return TimelineNode(
        key=key,
        job_key=job,
        machine_key=machine,
        duration=duration,
        job_label=job,
        machine_label=machine,
        operation_label=key,
    )


def event(
    kind: SimulationEventType, minutes: int, speed: str | None = None
) -> SimulationEventRecord:
    """Build a simulation event a fixed number of minutes after START."""
    return SimulationEventRecord(
        event_type=kind,
        occurred_at=START + timedelta(minutes=minutes),
        speed=None if speed is None else Decimal(speed),
    )


def floorsync_fixture() -> tuple[
    list[ScheduleEntryRecord], list[ScheduleDependencyRecord], dict[str, UUID]
]:
    """The same problem as SIMPLE_INSTANCE, expressed as FloorSync schedule rows.

    Frame runs Cut then Polish; Panel runs Trim then Finish. Machine queueing puts
    Cut before Finish on the Cutter, and Trim before Polish on the Polisher.
    """
    ids = {name: uuid4() for name in ("cut", "polish", "trim", "finish")}
    frame, panel = uuid4(), uuid4()
    cutter, polisher = uuid4(), uuid4()

    entries = [
        ScheduleEntryRecord(ids["cut"], frame, cutter, 3, "Frame", "Cutter", "Cut"),
        ScheduleEntryRecord(ids["polish"], frame, polisher, 2, "Frame", "Polisher", "Polish"),
        ScheduleEntryRecord(ids["trim"], panel, polisher, 4, "Panel", "Polisher", "Trim"),
        ScheduleEntryRecord(ids["finish"], panel, cutter, 1, "Panel", "Cutter", "Finish"),
    ]
    dependencies = [
        ScheduleDependencyRecord(ids["polish"], ids["cut"], PrecedenceReason.JOB_ORDER),
        ScheduleDependencyRecord(ids["finish"], ids["trim"], PrecedenceReason.JOB_ORDER),
        ScheduleDependencyRecord(ids["finish"], ids["cut"], PrecedenceReason.MACHINE_QUEUE),
        ScheduleDependencyRecord(ids["polish"], ids["trim"], PrecedenceReason.MACHINE_QUEUE),
    ]
    return entries, dependencies, ids


# -- instance parsing ----------------------------------------------------


def test_instance_parses_metadata_and_operations() -> None:
    instance = JobShopInstance.from_dict(SIMPLE_INSTANCE)

    assert instance.name == "simple"
    assert instance.machine_count == 2
    assert instance.job_count == 2
    assert len(instance.operations) == 4
    assert instance.job_ids == (0, 1)
    assert instance.machine_ids == (0, 1)
    assert instance.total_work == 10


def test_instance_lookups_return_operations_in_the_right_order() -> None:
    instance = JobShopInstance.from_dict(SIMPLE_INSTANCE)

    chain = instance.operations_for_job(0)
    assert [item.operation_index for item in chain] == [0, 1]
    assert instance.operation(1, 1).machine == 0
    assert {item.job for item in instance.operations_for_machine(0)} == {0, 1}


def test_instance_rejects_a_document_without_operations() -> None:
    with pytest.raises(InstanceFormatError, match="no 'data' array"):
        JobShopInstance.from_dict({"instance": "broken"})


def test_instance_rejects_an_operation_missing_a_field() -> None:
    with pytest.raises(InstanceFormatError, match="missing field"):
        JobShopInstance.from_dict({"data": [{"job": 0, "operation": 0, "machine": 0}]})


def test_instance_loads_from_a_file(tmp_path: Path) -> None:
    source = tmp_path / "simple.json"
    source.write_text(json.dumps(SIMPLE_INSTANCE), encoding="utf-8")

    assert JobShopInstance.load_from_json(source).name == "simple"


# -- benchmark solution parsing ------------------------------------------


def test_schedule_parses_machine_sequences() -> None:
    schedule = Schedule.from_dict(SIMPLE_SCHEDULE)

    assert schedule.instance_name == "simple"
    assert schedule.makespan == 6
    assert schedule.machine_ids == (0, 1)
    assert schedule.sequence_for_machine(1) == (1, 0)
    assert schedule.sequence_for_machine(9) == ()


def test_schedule_rejects_a_document_with_no_sequences() -> None:
    with pytest.raises(ScheduleFormatError, match="no 'machine_<id>' sequences"):
        Schedule.from_dict({"instance": "simple", "makespan": 6})


def test_schedule_selects_one_solution_from_a_solver_run(tmp_path: Path) -> None:
    other = dict(SIMPLE_SCHEDULE, instance="other", machine_0=[1, 0])
    source = tmp_path / "solutions.json"
    source.write_text(json.dumps([SIMPLE_SCHEDULE, other]), encoding="utf-8")

    assert Schedule.load_from_json(source, "other").sequence_for_machine(0) == (1, 0)


def test_schedule_requires_a_name_when_a_run_holds_several_solutions(tmp_path: Path) -> None:
    source = tmp_path / "solutions.json"
    source.write_text(json.dumps([SIMPLE_SCHEDULE, SIMPLE_SCHEDULE]), encoding="utf-8")

    with pytest.raises(ScheduleFormatError, match="pass instance_name"):
        Schedule.load_from_json(source)


# -- format-neutral core -------------------------------------------------


def test_resolve_start_times_takes_the_longest_path() -> None:
    nodes = [node("a", 3), node("b", 4), node("c", 2)]
    edges = [
        PrecedenceEdge("a", "c", PrecedenceReason.JOB_ORDER),
        PrecedenceEdge("b", "c", PrecedenceReason.MACHINE_QUEUE),
    ]

    assert resolve_start_times(nodes, edges) == {"a": 0, "b": 0, "c": 4}


def test_resolve_start_times_rejects_an_edge_naming_an_unknown_node() -> None:
    edges = [PrecedenceEdge("a", "ghost", PrecedenceReason.JOB_ORDER)]

    with pytest.raises(KeyError, match="unknown node"):
        resolve_start_times([node("a", 1)], edges)


def test_resolve_start_times_detects_a_cycle() -> None:
    edges = [
        PrecedenceEdge("a", "b", PrecedenceReason.JOB_ORDER),
        PrecedenceEdge("b", "a", PrecedenceReason.MACHINE_QUEUE),
    ]

    with pytest.raises(CyclicScheduleError, match="deadlock"):
        resolve_start_times([node("a", 1), node("b", 1)], edges)


def test_core_supports_fan_in_from_several_predecessors() -> None:
    """FloorSync dependencies allow many predecessors, unlike a benchmark chain."""
    nodes = [node("weld1", 5), node("weld2", 8), node("assemble", 2)]
    edges = [
        PrecedenceEdge("weld1", "assemble", PrecedenceReason.JOB_ORDER),
        PrecedenceEdge("weld2", "assemble", PrecedenceReason.JOB_ORDER),
    ]

    assert resolve_start_times(nodes, edges)["assemble"] == 8


def test_core_supports_a_cross_job_dependency() -> None:
    """An assembly step may depend on operations from more than one job."""
    nodes = [
        node("a", 4, job="job-a", machine="m1"),
        node("b", 6, job="job-b", machine="m2"),
        node("assemble", 1, job="job-c", machine="m3"),
    ]
    edges = [
        PrecedenceEdge("a", "assemble", PrecedenceReason.JOB_ORDER),
        PrecedenceEdge("b", "assemble", PrecedenceReason.JOB_ORDER),
    ]

    timeline = Timeline.from_graph(nodes, edges)

    assert timeline.makespan == 7
    assert timeline.job_keys == ("job-a", "job-b", "job-c")


# -- benchmark adapter ---------------------------------------------------


def test_builder_resolves_the_hand_computed_timeline() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    assert placement(timeline) == {
        ("Job 0", "Op 0"): (0, 3),
        ("Job 0", "Op 1"): (4, 6),
        ("Job 1", "Op 0"): (0, 4),
        ("Job 1", "Op 1"): (4, 5),
    }
    assert timeline.makespan == 6


def test_builder_reproduces_the_makespan_the_solver_recorded() -> None:
    schedule = Schedule.from_dict(SIMPLE_SCHEDULE)
    timeline = TimelineBuilder.build(JobShopInstance.from_dict(SIMPLE_INSTANCE), schedule)

    assert timeline.makespan == schedule.makespan


def test_builder_respects_job_precedence_and_machine_exclusivity() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)
    assert_no_machine_overlap(timeline)

    for job_key in timeline.job_keys:
        chain = sorted(timeline.operations_for_job(job_key), key=lambda item: item.start_time)
        for earlier, later in pairwise(chain):
            assert earlier.end_time <= later.start_time


def test_builder_binds_repeat_visits_in_sequence_order() -> None:
    timeline = build(REENTRANT_INSTANCE, REENTRANT_SCHEDULE)

    assert placement(timeline) == {
        ("Job 0", "Op 0"): (0, 2),
        ("Job 0", "Op 1"): (2, 5),
        ("Job 0", "Op 2"): (6, 7),
        ("Job 1", "Op 0"): (2, 6),
    }
    assert timeline.makespan == 7

    queue = timeline.operations_for_machine("0")
    assert [(item.job_label, item.operation_label) for item in queue] == [
        ("Job 0", "Op 0"),
        ("Job 1", "Op 0"),
        ("Job 0", "Op 2"),
    ]
    assert [item.machine_slot for item in queue] == [0, 1, 2]


def test_builder_rejects_a_sequence_of_the_wrong_length() -> None:
    with pytest.raises(ScheduleMismatchError, match="Machine 0 sequences"):
        build(SIMPLE_INSTANCE, dict(SIMPLE_SCHEDULE, machine_0=[0]))


def test_builder_rejects_a_sequence_naming_an_absent_job() -> None:
    with pytest.raises(ScheduleMismatchError, match="no remaining operation"):
        build(SIMPLE_INSTANCE, dict(SIMPLE_SCHEDULE, machine_0=[0, 0]))


def test_builder_detects_a_deadlocked_schedule() -> None:
    deadlock_instance = {
        "instance": "deadlock",
        "data": [
            {"job": 0, "operation": 0, "machine": 0, "duration": 1},
            {"job": 0, "operation": 1, "machine": 1, "duration": 1},
            {"job": 1, "operation": 0, "machine": 1, "duration": 1},
            {"job": 1, "operation": 1, "machine": 0, "duration": 1},
        ],
    }
    deadlock_schedule = {"instance": "deadlock", "machine_0": [1, 0], "machine_1": [0, 1]}

    with pytest.raises(CyclicScheduleError, match="deadlock"):
        build(deadlock_instance, deadlock_schedule)


# -- FloorSync adapter ---------------------------------------------------


def test_floorsync_adapter_resolves_schedule_rows() -> None:
    entries, dependencies, _ = floorsync_fixture()

    timeline = FloorSyncScheduleAdapter.build_timeline(entries, dependencies)

    assert placement(timeline) == {
        ("Frame", "Cut"): (0, 3),
        ("Frame", "Polish"): (4, 6),
        ("Panel", "Trim"): (0, 4),
        ("Panel", "Finish"): (4, 5),
    }
    assert timeline.makespan == 6
    assert_no_machine_overlap(timeline)


def test_floorsync_adapter_matches_the_equivalent_benchmark_schedule() -> None:
    """The same problem through both adapters must resolve identically."""
    entries, dependencies, _ = floorsync_fixture()

    floorsync = FloorSyncScheduleAdapter.build_timeline(entries, dependencies)
    benchmark = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    assert floorsync.makespan == benchmark.makespan
    assert sorted(placement(floorsync).values()) == sorted(placement(benchmark).values())


def test_floorsync_timeline_carries_real_names_for_display() -> None:
    entries, dependencies, _ = floorsync_fixture()

    timeline = FloorSyncScheduleAdapter.build_timeline(entries, dependencies)

    machine = timeline.machine_status_at(timeline.machine_keys[0], 1)
    assert machine.machine_label == "Cutter"

    jobs = [timeline.job_status_at(key, 0) for key in timeline.job_keys]
    assert [state.job_label for state in jobs] == ["Frame", "Panel"]


def test_floorsync_adapter_derives_the_machine_queue_it_never_stored() -> None:
    entries, dependencies, _ = floorsync_fixture()

    timeline = FloorSyncScheduleAdapter.build_timeline(entries, dependencies)
    cutter = next(
        key for key in timeline.machine_keys if timeline.machine_status_at(key, 0).machine_label
    )
    queue = timeline.operations_for_machine(cutter)

    assert [item.machine_slot for item in queue] == list(range(len(queue)))


def test_floorsync_adapter_rejects_a_stale_dependency_cache() -> None:
    entries, dependencies, _ = floorsync_fixture()
    dependencies.append(
        ScheduleDependencyRecord(entries[0].entry_id, uuid4(), PrecedenceReason.JOB_ORDER)
    )

    with pytest.raises(ScheduleMismatchError, match="not part of the loaded schedule"):
        FloorSyncScheduleAdapter.build_timeline(entries, dependencies)


def test_floorsync_adapter_detects_a_deadlocked_dependency_cache() -> None:
    entries, dependencies, ids = floorsync_fixture()
    dependencies.append(
        ScheduleDependencyRecord(ids["cut"], ids["polish"], PrecedenceReason.MACHINE_QUEUE)
    )

    with pytest.raises(CyclicScheduleError, match="deadlock"):
        FloorSyncScheduleAdapter.build_timeline(entries, dependencies)


def test_floorsync_adapter_builds_records_from_query_rows() -> None:
    entry_id, job_id, machine_id = uuid4(), uuid4(), uuid4()

    entries = FloorSyncScheduleAdapter.entries_from_rows(
        [(entry_id, job_id, machine_id, 5, "Frame", "Cutter", "Cut")]
    )
    dependencies = FloorSyncScheduleAdapter.dependencies_from_rows(
        [(entry_id, entry_id, "machine_queue")]
    )

    assert entries[0].duration == 5
    assert entries[0].machine_name == "Cutter"
    assert dependencies[0].reason is PrecedenceReason.MACHINE_QUEUE


def test_floorsync_adapter_rejects_an_unknown_dependency_reason() -> None:
    with pytest.raises(ScheduleMismatchError, match="unknown reason"):
        FloorSyncScheduleAdapter.dependencies_from_rows([(uuid4(), uuid4(), "vibes")])


# -- timeline queries ----------------------------------------------------


def test_active_at_uses_a_half_open_interval() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    assert {item.job_label for item in timeline.active_at(0)} == {"Job 0", "Job 1"}
    assert [item.job_label for item in timeline.active_at(3)] == ["Job 1"]
    assert timeline.active_at(6) == ()


def test_machine_status_reports_the_operation_in_progress() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    busy = timeline.machine_status_at("0", 1)
    assert busy.status is MachineStatus.BUSY
    assert busy.current is not None
    assert busy.current.job_label == "Job 0"
    assert busy.remaining_count == 2

    idle = timeline.machine_status_at("0", 3)
    assert idle.status is MachineStatus.IDLE
    assert idle.current is None
    assert idle.completed_count == 1


def test_machine_utilization_is_busy_time_over_elapsed_time() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    assert timeline.machine_status_at("0", 0).utilization == 0.0
    assert timeline.machine_status_at("0", 4).utilization == pytest.approx(3 / 4)
    assert timeline.machine_status_at("1", 6).utilization == pytest.approx(1.0)


def test_job_status_moves_from_waiting_to_running_to_done() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    running = timeline.job_status_at("0", 0)
    assert running.status is JobStatus.RUNNING
    assert running.current is not None
    assert running.completion_time is None

    waiting = timeline.job_status_at("0", 3)
    assert waiting.status is JobStatus.WAITING
    assert waiting.next_up is not None
    assert waiting.next_up.operation_label == "Op 1"
    assert waiting.progress == pytest.approx(0.5)

    done = timeline.job_status_at("0", 6)
    assert done.status is JobStatus.DONE
    assert done.completion_time == 6
    assert done.progress == pytest.approx(1.0)


def test_machine_slot_is_derived_from_resolved_start_times() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    assert [item.machine_slot for item in timeline.operations_for_machine("0")] == [0, 1]
    assert [item.machine_slot for item in timeline.operations_for_machine("1")] == [0, 1]


# -- clock ---------------------------------------------------------------


def test_clock_advances_only_while_playing() -> None:
    clock = PlaybackClock(duration=10)

    clock.tick(1.0)
    assert clock.current_time == 0.0

    clock.play()
    clock.tick(1.0)
    assert clock.current_time == pytest.approx(1.0)


def test_clock_scales_elapsed_time_by_speed() -> None:
    clock = PlaybackClock(duration=10, playing=True)
    clock.set_speed(2.5)
    clock.tick(2.0)

    assert clock.current_time == pytest.approx(5.0)


def test_clock_stops_and_clamps_at_the_end() -> None:
    clock = PlaybackClock(duration=5, playing=True)
    clock.tick(100)

    assert clock.current_time == 5
    assert clock.playing is False
    assert clock.at_end


def test_clock_loops_when_asked() -> None:
    clock = PlaybackClock(duration=5, playing=True, loop=True)
    clock.tick(7)

    assert clock.current_time == pytest.approx(2.0)
    assert clock.playing is True


def test_clock_play_restarts_once_finished() -> None:
    clock = PlaybackClock(duration=5, current_time=5)
    clock.play()

    assert clock.current_time == 0.0


def test_clock_seek_clamps_and_keeps_playing() -> None:
    clock = PlaybackClock(duration=5, playing=True)

    clock.seek(-3)
    assert clock.current_time == 0.0
    clock.seek(99)
    assert clock.current_time == 5
    assert clock.playing is True

    clock.seek_fraction(0.5)
    assert clock.current_time == pytest.approx(2.5)
    assert clock.progress == pytest.approx(0.5)


def test_clock_rejects_a_non_positive_speed() -> None:
    with pytest.raises(ValueError, match="speed must be positive"):
        PlaybackClock(duration=5).set_speed(0)


# -- simulated time derived from the event log ---------------------------


def test_derived_time_advances_with_real_time_while_running() -> None:
    point = derive_simulated_time(
        [event(SimulationEventType.STARTED, 0, "1")], at=START + timedelta(minutes=10)
    )

    assert point.time == pytest.approx(600.0)
    assert point.is_running is True


def test_derived_time_scales_by_speed() -> None:
    point = derive_simulated_time(
        [event(SimulationEventType.STARTED, 0, "2")], at=START + timedelta(minutes=10)
    )

    assert point.time == pytest.approx(1200.0)
    assert point.speed == pytest.approx(2.0)


def test_derived_time_freezes_across_a_pause() -> None:
    """The reason the event log exists: started_at + speed keeps advancing here."""
    events = [
        event(SimulationEventType.STARTED, 0, "1"),
        event(SimulationEventType.PAUSED, 5),
    ]

    at_pause = derive_simulated_time(events, at=START + timedelta(minutes=5))
    much_later = derive_simulated_time(events, at=START + timedelta(hours=3))

    assert at_pause.time == pytest.approx(300.0)
    assert much_later.time == pytest.approx(300.0)
    assert much_later.is_running is False


def test_derived_time_resumes_from_where_it_paused() -> None:
    events = [
        event(SimulationEventType.STARTED, 0, "1"),
        event(SimulationEventType.PAUSED, 5),
        event(SimulationEventType.RESUMED, 60, "1"),
    ]

    point = derive_simulated_time(events, at=START + timedelta(minutes=62))

    assert point.time == pytest.approx(420.0)
    assert point.is_running is True


def test_derived_time_applies_a_speed_change_only_going_forward() -> None:
    events = [
        event(SimulationEventType.STARTED, 0, "1"),
        event(SimulationEventType.SPEED_CHANGED, 10, "3"),
    ]

    point = derive_simulated_time(events, at=START + timedelta(minutes=12))

    assert point.time == pytest.approx(600 + 360.0)
    assert point.speed == pytest.approx(3.0)


def test_derived_time_rewinds_on_reset() -> None:
    events = [
        event(SimulationEventType.STARTED, 0, "1"),
        event(SimulationEventType.RESET, 10),
    ]

    point = derive_simulated_time(events, at=START + timedelta(minutes=30))

    assert point.time == 0.0
    assert point.is_running is False


def test_derived_time_clamps_and_completes_at_the_makespan() -> None:
    point = derive_simulated_time(
        [event(SimulationEventType.STARTED, 0, "1")],
        at=START + timedelta(minutes=10),
        makespan=120,
    )

    assert point.time == 120
    assert point.is_complete is True
    assert point.is_running is False


def test_derived_time_replays_events_out_of_order() -> None:
    events = [
        event(SimulationEventType.PAUSED, 5),
        event(SimulationEventType.STARTED, 0, "1"),
    ]

    point = derive_simulated_time(events, at=START + timedelta(hours=1))

    assert point.time == pytest.approx(300.0)


def test_derived_time_is_zero_before_anything_happened() -> None:
    point = derive_simulated_time([], at=START)

    assert point.time == 0.0
    assert point.is_running is False


def test_derived_time_requires_timezone_aware_inputs() -> None:
    with pytest.raises(SimulationTimelineError, match="timezone-aware"):
        derive_simulated_time([], at=datetime(2026, 9, 5, 8, 0))


def test_derived_time_rejects_a_speed_event_with_no_speed() -> None:
    with pytest.raises(SimulationTimelineError, match="must carry a speed"):
        derive_simulated_time([event(SimulationEventType.STARTED, 0)], at=START)


def test_events_from_rows_parses_stored_values() -> None:
    records = events_from_rows([("started", START, Decimal("2.5"))])

    assert records[0].event_type is SimulationEventType.STARTED
    assert records[0].speed == Decimal("2.5")


def test_events_from_rows_rejects_an_unknown_event_type() -> None:
    with pytest.raises(SimulationTimelineError, match="unknown type"):
        events_from_rows([("exploded", START, None)])


# -- engine --------------------------------------------------------------


def make_engine() -> SimulationEngine:
    return SimulationEngine(build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE))


def test_engine_requires_a_timeline_before_reading_state() -> None:
    with pytest.raises(SimulationError, match="Adopt a timeline"):
        SimulationEngine().snapshot()


def test_engine_requires_an_instance_before_a_benchmark_schedule() -> None:
    with pytest.raises(SimulationError, match="Load an instance"):
        SimulationEngine().apply_schedule(Schedule.from_dict(SIMPLE_SCHEDULE))


def test_engine_plays_a_floorsync_timeline() -> None:
    entries, dependencies, _ = floorsync_fixture()
    engine = SimulationEngine(FloorSyncScheduleAdapter.build_timeline(entries, dependencies))

    snapshot = engine.seek(4)

    assert snapshot.makespan == 6
    assert {item.job_label for item in snapshot.active} == {"Frame", "Panel"}


def test_engine_loads_benchmark_files_and_reports_readiness(tmp_path: Path) -> None:
    instance_path = tmp_path / "simple.json"
    instance_path.write_text(json.dumps(SIMPLE_INSTANCE), encoding="utf-8")
    schedule_path = tmp_path / "solutions.json"
    schedule_path.write_text(json.dumps([SIMPLE_SCHEDULE]), encoding="utf-8")

    engine = SimulationEngine()
    assert engine.is_ready is False
    engine.load_instance(instance_path)
    assert engine.is_ready is False
    timeline = engine.load_schedule(schedule_path)

    assert engine.is_ready is True
    assert timeline.makespan == 6
    assert engine.clock.duration == 6


def test_engine_snapshot_describes_every_machine_and_job() -> None:
    snapshot = make_engine().seek(4)

    assert snapshot.time == 4
    assert snapshot.makespan == 6
    assert len(snapshot.machines) == 2
    assert len(snapshot.jobs) == 2
    assert {item.job_label for item in snapshot.active} == {"Job 0", "Job 1"}
    assert snapshot.is_complete is False
    assert snapshot.progress == pytest.approx(4 / 6)


def test_engine_reports_completion_at_the_makespan() -> None:
    snapshot = make_engine().seek(6)

    assert snapshot.is_complete is True
    assert snapshot.active == ()
    assert all(job.status is JobStatus.DONE for job in snapshot.jobs)


def test_engine_notifies_observers_on_each_new_frame() -> None:
    engine = make_engine()
    seen: list[SimulationSnapshot] = []
    unsubscribe = engine.subscribe(seen.append)

    engine.seek(2)
    engine.play()
    engine.tick(1.0)
    assert len(seen) == 2
    assert seen[-1].time == pytest.approx(3.0)

    unsubscribe()
    engine.seek(5)
    assert len(seen) == 2


def test_engine_does_not_republish_a_paused_tick() -> None:
    engine = make_engine()
    seen: list[SimulationSnapshot] = []
    engine.subscribe(seen.append)

    engine.tick(1.0)

    assert seen == []


def test_engine_supports_observer_objects() -> None:
    class Recorder:
        def __init__(self) -> None:
            self.frames: list[SimulationSnapshot] = []

        def on_update(self, snapshot: SimulationSnapshot) -> None:
            self.frames.append(snapshot)

    engine = make_engine()
    recorder = Recorder()
    engine.subscribe(recorder)
    engine.seek(1)

    assert len(recorder.frames) == 1


def test_engine_frames_walk_the_run_and_restore_the_play_head() -> None:
    engine = make_engine()
    engine.seek(2)

    frames = list(engine.frames(step=2.0))

    assert [frame.time for frame in frames] == [0.0, 2.0, 4.0, 6.0]
    assert frames[-1].is_complete is True
    assert engine.clock.current_time == 2


def test_engine_reset_rewinds_and_pauses() -> None:
    engine = make_engine()
    engine.play()
    engine.seek(5)

    snapshot = engine.reset()

    assert snapshot.time == 0.0
    assert engine.clock.playing is False


def test_engine_resynchronises_to_a_derived_position() -> None:
    """The database is authoritative; the local clock follows the derived time."""
    engine = make_engine()

    point = derive_simulated_time(
        [event(SimulationEventType.STARTED, 0, "1")],
        at=START + timedelta(seconds=4),
        makespan=6,
    )
    snapshot = engine.seek(point.time)

    assert snapshot.time == pytest.approx(4.0)
