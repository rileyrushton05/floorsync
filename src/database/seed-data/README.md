# Seed data

Job-shop benchmark instances used to populate a development database with a known scenario.

Load one with `make db-seed instance=ft06`. Seeding replaces the current scenario: every job,
operation, machine, schedule and simulation is deleted first, so the database always holds exactly
one instance.

## Source and licence

The files in `jobshop/` are copied unmodified from
[ScheduleOpt/benchmarks](https://github.com/ScheduleOpt/benchmarks)
(`jobshop/instances/json/`), which publishes them under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). They are the standard academic
job-shop scheduling instances — the same problems the literature reports results against, which is
what makes them useful for judging our scheduler rather than only demonstrating it.

The upstream repository holds 376 instances totalling around 137 MB. Only the five below are
committed here; add another by copying it out of that repository into `jobshop/`, keeping the
upstream filename. No code change is needed — the loader lists whatever is in the directory.

## Committed instances

| Instance | Jobs | Machines | Operations | Why it is here |
| --- | ---: | ---: | ---: | --- |
| `ft06` | 6 | 6 | 36 | Smallest useful case. Fast enough to run in a test or to eyeball by hand. |
| `abz5` | 10 | 10 | 100 | Small square instance, a common reference point in the literature. |
| `ta01js` | 15 | 15 | 225 | Mid-sized square instance. |
| `swv11` | 50 | 10 | 500 | Many jobs over few machines, so machine contention dominates. |
| `bel00` | 792 | 48 | 5,372 | The awkward one: jobs have between 1 and 3+ operations instead of a uniform count, and a job can revisit a machine it has already used. Use it to check the scheduler and simulation handle uneven, reentrant work rather than only the tidy square case. |

Note that `dmu*` and `ta*` are **not** reentrant, despite what #126 assumed — they are square
instances where each job visits each machine exactly once. `bel*` and `dct*` are the reentrant
families.

## File format

```json
{
  "instance": "ft06",
  "family": "ft",
  "jobs": 6,
  "machines": 6,
  "data": [{ "job": 0, "operation": 0, "machine": 2, "duration": 1 }]
}
```

Each `data` entry is one operation. `operation` is its position within its job, and that ordering is
the only precedence information the file carries: operation 1 runs after operation 0, and so on.
Jobs and machines are bare integers, numbered from zero.

## What the loader does and does not fill in

These instances describe a pure scheduling problem, so they carry no cost or organisational data.
The loader writes only what the file actually states and leaves the rest `NULL`:

| Filled from the file | Left `NULL` or absent |
| --- | --- |
| `jobs`, `operations` | `machines.salary` — no labour cost in the source |
| `machines` (name only) | `machines.category_id` — no categories in the source |
| `dependencies` — the per-job operation chain | `compatibilities.energy` — no energy figures in the source |
| `compatibilities` — the machine and duration for each operation | `users` / `user_credentials` — no operators in the source |

`NULL` here means "the source does not record this", not zero. Cost reporting must exclude such a
row rather than treat it as free. Each operation gets exactly one compatible machine, because that
is what the file specifies — a seeded benchmark exercises sequencing, not machine choice.

Durations are unitless integers upstream. They are stored as-is in `compatibilities.duration`, which
the schema documents as minutes; treat the unit as nominal for benchmark scenarios.
