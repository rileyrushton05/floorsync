"""Load job-shop benchmark instances into the FloorSync database.

The instance files are academic job-shop problems (see src/database/seed-data/README.md). They carry
jobs, machines, per-operation durations and nothing else, so a seeded scenario has no cost data, no
categories and no logins -- only what the source file actually states.
"""

from floorsync_common.seed.instances import (
    BenchmarkInstance,
    BenchmarkOperation,
    InstanceError,
    available_instances,
    load_instance,
    parse_instance,
)
from floorsync_common.seed.loader import SeedSummary, seed_instance

__all__ = [
    "BenchmarkInstance",
    "BenchmarkOperation",
    "InstanceError",
    "SeedSummary",
    "available_instances",
    "load_instance",
    "parse_instance",
    "seed_instance",
]
