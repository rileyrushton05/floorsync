"""Print a schedule as readable text.

Run it against an instance and a solution file to see what the resolver made of
them, without a database, an API or a browser:

    python -m floorsync_common.simulation \\
        tests/backend/data/abz5.json \\
        tests/backend/data/solutions_greedy-spt_2026-09-06.json

Add ``--at`` to inspect one instant instead of the whole run. This is a
development aid for eyeballing a schedule; the tests are the actual checks.
"""

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from floorsync_common.simulation.engine import SimulationEngine
from floorsync_common.simulation.errors import SimulationError
from floorsync_common.simulation.timeline import Timeline

GLYPHS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
IDLE = "."
OVERFLOW = "#"


def job_glyphs(timeline: Timeline) -> dict[str, str]:
    """Assign each job a single character for the chart."""
    return {
        key: (GLYPHS[index] if index < len(GLYPHS) else OVERFLOW)
        for index, key in enumerate(timeline.job_keys)
    }


def render_gantt(timeline: Timeline, width: int = 90) -> str:
    """Draw machine lanes as rows of characters, one glyph per job.

    Each column is a slice of simulated time, so a bar's length is proportional
    to its duration. Very short operations still occupy one column, which means
    the chart shows what ran where rather than exact widths.
    """
    if timeline.makespan <= 0 or width <= 0:
        return "(nothing to draw)"

    glyphs = job_glyphs(timeline)
    label_width = max(
        len(timeline.machine_status_at(key, 0).machine_label) for key in timeline.machine_keys
    )

    lines: list[str] = []
    for machine_key in timeline.machine_keys:
        lane = [IDLE] * width
        for item in timeline.operations_for_machine(machine_key):
            first = int(item.start_time / timeline.makespan * width)
            last = int(item.end_time / timeline.makespan * width)
            for column in range(first, max(last, first + 1)):
                if column < width:
                    lane[column] = glyphs[item.job_key]
        label = timeline.machine_status_at(machine_key, 0).machine_label
        lines.append(f"{label:>{label_width}} |{''.join(lane)}|")

    axis = f"{'':>{label_width}} 0{'':<{width - 2}}{timeline.makespan}"
    return "\n".join([axis, *lines])


def render_legend(timeline: Timeline) -> str:
    """List which glyph belongs to which job."""
    glyphs = job_glyphs(timeline)
    entries = [
        f"{glyphs[key]}={timeline.job_status_at(key, 0).job_label}" for key in timeline.job_keys
    ]
    return "jobs: " + "  ".join(entries)


def render_machine_table(timeline: Timeline) -> str:
    """Summarise each machine's load over the whole run."""
    label_width = max(
        len(timeline.machine_status_at(key, 0).machine_label) for key in timeline.machine_keys
    )
    header = f"{'machine':>{label_width}}  {'ops':>4}  {'busy':>6}  {'idle':>6}  {'util':>5}"
    rows = [header, "-" * len(header)]
    for machine_key in timeline.machine_keys:
        operations = timeline.operations_for_machine(machine_key)
        busy = sum(item.duration for item in operations)
        idle = timeline.makespan - busy
        share = busy / timeline.makespan if timeline.makespan else 0.0
        label = timeline.machine_status_at(machine_key, 0).machine_label
        rows.append(
            f"{label:>{label_width}}  {len(operations):>4}  {busy:>6}  {idle:>6}  {share:>4.0%}"
        )
    return "\n".join(rows)


def render_snapshot(engine: SimulationEngine, at: float) -> str:
    """Describe what every machine is doing at one instant."""
    snapshot = engine.seek(at)
    lines = [
        f"t = {snapshot.time:g} of {snapshot.makespan}  ({snapshot.progress:.0%})",
        "",
    ]
    label_width = max(len(machine.machine_label) for machine in snapshot.machines)
    for machine in snapshot.machines:
        if machine.current is None:
            detail = "idle"
        else:
            item = machine.current
            detail = (
                f"{item.job_label} / {item.operation_label} ({item.start_time}-{item.end_time})"
            )
        lines.append(f"  {machine.machine_label:>{label_width}}  {detail}")

    done = sum(1 for job in snapshot.jobs if job.status == "done")
    running = sum(1 for job in snapshot.jobs if job.status == "running")
    lines.append("")
    lines.append(
        f"  jobs: {running} running, {done} done, {len(snapshot.jobs) - running - done} waiting"
    )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    """Define the command-line interface."""
    parser = argparse.ArgumentParser(
        prog="python -m floorsync_common.simulation",
        description="Resolve a benchmark instance and solution, and print the result.",
    )
    parser.add_argument("instance", type=Path, help="path to an instance JSON file")
    parser.add_argument("solution", type=Path, help="path to a solutions_*.json file")
    parser.add_argument(
        "--instance-name",
        default=None,
        help="which solution to use when the file holds several",
    )
    parser.add_argument("--width", type=int, default=90, help="chart width in characters")
    parser.add_argument(
        "--at",
        type=float,
        default=None,
        help="print the state at this simulated time instead of the whole run",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Print a resolved schedule. Returns a process exit code."""
    args = build_parser().parse_args(argv)

    engine = SimulationEngine()
    try:
        instance = engine.load_instance(args.instance)
        timeline = engine.load_schedule(args.solution, args.instance_name or instance.name)
    except (SimulationError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    schedule = engine.schedule
    recorded = schedule.makespan if schedule is not None else None
    solver = schedule.solver if schedule is not None else "unknown"

    print(
        f"{instance.name} · {solver or 'unknown solver'} · "
        f"{instance.job_count} jobs x {instance.machine_count} machines · "
        f"{len(instance.operations)} operations"
    )
    print(f"makespan {timeline.makespan}", end="")
    if recorded is None:
        print("  (no makespan recorded in the solution file)")
    elif recorded == timeline.makespan:
        print(f"  (matches the {recorded} recorded in the solution file)")
    else:
        print(f"  (DISAGREES with the {recorded} recorded in the solution file)")
    print()

    if args.at is not None:
        print(render_snapshot(engine, args.at))
        return 0

    print(render_gantt(timeline, args.width))
    print()
    print(render_legend(timeline))
    print()
    print(render_machine_table(timeline))
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
