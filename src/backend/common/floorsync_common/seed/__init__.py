"""Load job-shop benchmark instances into the FloorSync database.

The instance files are academic job-shop problems (see src/database/seed-data/README.md). They carry
jobs, machines, per-operation durations and nothing else, so a seeded scenario has no cost data, no
categories and no logins -- only what the source file actually states.

Import from the submodule you need. `instances` and `flexible` are pure parsers that the file import
(`floorsync_common.imports`) reuses, so this package deliberately re-exports nothing: an eager
re-export of `loader` would drag the database layer into every caller that only wants to parse.
"""
