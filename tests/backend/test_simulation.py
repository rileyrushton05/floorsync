"""Tests for the schedule playback simulation package."""

import json
from itertools import pairwise
from pathlib import Path
from typing import Any

import pytest

from floorsync_common.simulation import (
    CyclicScheduleError,
    InstanceFormatError,
    JobShopInstance,
    JobStatus,
    MachineStatus,
    PlaybackClock,
    Schedule,
    ScheduleFormatError,
    ScheduleMismatchError,
    SimulationEngine,
    SimulationError,
    SimulationSnapshot,
    TimelineBuilder,
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
#   job 1 op 0  machine 0  duration 4   ->  2..6   (machine 0, after job 0's first visit)
#   job 0 op 2  machine 0  duration 1   ->  6..7   (machine 0, after job 1)
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


def build(instance_doc: dict[str, Any], schedule_doc: dict[str, Any]) -> Any:
    """Parse both documents and resolve them into a timeline."""
    return TimelineBuilder.build(
        JobShopInstance.from_dict(instance_doc), Schedule.from_dict(schedule_doc)
    )


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


# -- schedule parsing ----------------------------------------------------


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


# -- timeline building ---------------------------------------------------


def test_builder_resolves_the_hand_computed_timeline() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)
    times = {
        (item.job, item.operation_index): (item.start_time, item.end_time)
        for item in timeline.operations
    }

    assert times == {(0, 0): (0, 3), (0, 1): (4, 6), (1, 0): (0, 4), (1, 1): (4, 5)}
    assert timeline.makespan == 6


def test_builder_reproduces_the_makespan_the_solver_recorded() -> None:
    schedule = Schedule.from_dict(SIMPLE_SCHEDULE)
    timeline = TimelineBuilder.build(JobShopInstance.from_dict(SIMPLE_INSTANCE), schedule)

    assert timeline.makespan == schedule.makespan


def test_builder_respects_job_precedence_and_machine_exclusivity() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    for job_id in timeline.job_ids:
        chain = timeline.operations_for_job(job_id)
        for earlier, later in pairwise(chain):
            assert earlier.end_time <= later.start_time

    for machine_id in timeline.machine_ids:
        ordered = sorted(timeline.operations_for_machine(machine_id), key=lambda i: i.start_time)
        for earlier, later in pairwise(ordered):
            assert earlier.end_time <= later.start_time


def test_builder_binds_repeat_visits_in_sequence_order() -> None:
    timeline = build(REENTRANT_INSTANCE, REENTRANT_SCHEDULE)
    times = {
        (item.job, item.operation_index): (item.start_time, item.end_time)
        for item in timeline.operations
    }

    assert times == {(0, 0): (0, 2), (0, 1): (2, 5), (0, 2): (6, 7), (1, 0): (2, 6)}
    assert timeline.makespan == 7

    slots = {(i.job, i.operation_index): i.machine_slot for i in timeline.operations_for_machine(0)}
    assert slots == {(0, 0): 0, (1, 0): 1, (0, 2): 2}


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


# -- timeline queries ----------------------------------------------------


def test_active_at_uses_a_half_open_interval() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    assert {item.job for item in timeline.active_at(0)} == {0, 1}
    assert [item.job for item in timeline.active_at(3)] == [1]
    assert timeline.active_at(6) == ()


def test_machine_status_reports_the_operation_in_progress() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    busy = timeline.machine_status_at(0, 1)
    assert busy.status is MachineStatus.BUSY
    assert busy.current is not None
    assert busy.current.job == 0
    assert busy.remaining_count == 2

    idle = timeline.machine_status_at(0, 3)
    assert idle.status is MachineStatus.IDLE
    assert idle.current is None
    assert idle.completed_count == 1


def test_machine_utilization_is_busy_time_over_elapsed_time() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    assert timeline.machine_status_at(0, 0).utilization == 0.0
    assert timeline.machine_status_at(0, 4).utilization == pytest.approx(3 / 4)
    assert timeline.machine_status_at(1, 6).utilization == pytest.approx(1.0)


def test_job_status_moves_from_waiting_to_running_to_done() -> None:
    timeline = build(SIMPLE_INSTANCE, SIMPLE_SCHEDULE)

    running = timeline.job_status_at(0, 0)
    assert running.status is JobStatus.RUNNING
    assert running.current_op_index == 0
    assert running.completion_time is None

    waiting = timeline.job_status_at(0, 3)
    assert waiting.status is JobStatus.WAITING
    assert waiting.current_op_index == 1
    assert waiting.progress == pytest.approx(0.5)

    done = timeline.job_status_at(0, 6)
    assert done.status is JobStatus.DONE
    assert done.completion_time == 6
    assert done.progress == pytest.approx(1.0)


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


# -- engine --------------------------------------------------------------


def make_engine() -> SimulationEngine:
    engine = SimulationEngine()
    engine._instance = JobShopInstance.from_dict(SIMPLE_INSTANCE)
    engine.apply_schedule(Schedule.from_dict(SIMPLE_SCHEDULE))
    return engine


def test_engine_requires_an_instance_before_a_schedule() -> None:
    with pytest.raises(SimulationError, match="Load an instance"):
        SimulationEngine().apply_schedule(Schedule.from_dict(SIMPLE_SCHEDULE))


def test_engine_requires_a_schedule_before_reading_state() -> None:
    with pytest.raises(SimulationError, match="before reading state"):
        SimulationEngine().snapshot()


def test_engine_loads_from_files_and_reports_readiness(tmp_path: Path) -> None:
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
    assert {item.job for item in snapshot.active} == {0, 1}
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
