"""Command line entry point: `python -m floorsync_common.seed <instance>`."""

from __future__ import annotations

import argparse
import asyncio
import sys

from floorsync_common.database.session import session_scope
from floorsync_common.seed.instances import (
    DEFAULT_INSTANCE_DIRECTORY,
    InstanceError,
    available_instances,
    load_instance,
)
from floorsync_common.seed.loader import SeedSummary, seed_instance
from floorsync_common.seed.solutions import SolutionError, find_solution


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m floorsync_common.seed",
        description=(
            "Replace the database's scenario data with a job-shop benchmark instance. "
            "Existing jobs, machines, schedules and simulations are deleted first."
        ),
    )
    parser.add_argument(
        "instance",
        nargs="?",
        help="name of the instance to load, without the .json suffix (for example: ft06)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="list the instances available to load, then exit",
    )
    return parser


async def run(name: str) -> SeedSummary:
    instance = load_instance(name)
    solution = find_solution(name)
    async with session_scope() as session:
        return await seed_instance(session, instance, solution)


def report(summary: SeedSummary) -> None:
    print(f"Loaded {summary.instance} (family {summary.family})")
    for label, value in (
        ("machines", summary.machines),
        ("jobs", summary.jobs),
        ("operations", summary.operations),
        ("dependencies", summary.dependencies),
        ("compatibilities", summary.compatibilities),
    ):
        print(f"  {label:<16}{value:>8,}")

    if summary.solver is None:
        print("No solution available, so no schedule was created -- the problem only.")
    else:
        print(f"Schedule from {summary.solver} (makespan {summary.makespan:,}), confirmed")
        for label, value in (
            ("entries", summary.schedule_entries),
            ("precedence", summary.schedule_dependencies),
        ):
            print(f"  {label:<16}{value:>8,}")

    if summary.removed_operator_logins:
        print(
            f"  removed {summary.removed_operator_logins} operator login(s) bound to the "
            "machines that were replaced"
        )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)

    if arguments.list:
        names = available_instances()
        if not names:
            print(f"No instance files found in {DEFAULT_INSTANCE_DIRECTORY}", file=sys.stderr)
            return 1
        print("\n".join(names))
        return 0

    if not arguments.instance:
        parser.error("an instance name is required unless --list is given")

    try:
        summary = asyncio.run(run(arguments.instance))
    except (InstanceError, SolutionError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    report(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
