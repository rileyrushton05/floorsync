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

## Flexible instances (`flexible-jobshop/`)

The instances in `jobshop/` above fix each operation to one machine. A **flexible** instance
(FJSP) instead lists several machines an operation could run on, each with its own duration, so
choosing the machine is part of the problem. That is what `compatibilities` was built for: one
operation, several rows.

| Instance | Jobs | Operations | Compatibility rows | Why it is here |
| --- | ---: | ---: | ---: | --- |
| `fattahi1` | 2 | 4 | 8 | Smallest useful case — small enough to check by hand. |
| `kacem1` | 4 | 12 | 60 | Every operation can run on all 5 machines; the machine-choice case at its most open. |
| `dafjs01` | 4 | 26 | 82 | An assembly instance with **fan-in** precedence (one operation waiting on three) and sparsely numbered jobs. |
| `behnke58` | 100 | 500 | 9,748 | Volume: ~19 candidate machines per operation on average. |

Same source and licence as the classic instances, from
[`flexible-jobshop/instances/json/`](https://github.com/ScheduleOpt/benchmarks/tree/main/flexible-jobshop/instances/json)
(452 instances upstream, far too many to commit).

```json
{
  "instance": "fattahi1",
  "operations": [
    { "operation": 0, "option": 0, "machine": 0, "duration": 25 },
    { "operation": 0, "option": 1, "machine": 1, "duration": 37 }
  ],
  "precedences": [{ "before": 0, "after": 1, "job": 0 }]
}
```

Two differences matter when reading these files:

- **Precedence is explicit**, as `before`/`after` edges rather than implied by operation order. A job
  can therefore branch — several operations feeding one — which the classic format cannot express.
  These edges become `dependencies` rows directly.
- **An operation states no job of its own.** Its job comes from the `job` label on the precedence
  edges it appears in, and those labels are not necessarily contiguous (`dafjs01` uses 0, 9, 14, 19),
  so nothing may index jobs by position. An operation appearing in no edge at all — a job of one
  operation — is rejected rather than guessed, since this format cannot express it.

## Solutions

`solutions/` holds solved schedules. When one exists for the instance being seeded it is loaded
automatically, producing a confirmed `schedules` row, one `schedule_entry` per operation, and the
`schedule_dependencies` cache the simulation replays. Instances with no solution seed the problem
only.

| Solution | Instance | Source |
| --- | --- | --- |
| `solutions_greedy-spt_2026-09-06.json` | `abz5` | Classic. Produced by a `greedy-spt` heuristic. |
| `solutions_greedy-eft_2026-09-08.json` | `fattahi1`, `kacem1`, `dafjs01`, `behnke58` | Flexible. Produced by a greedy earliest-finish-time heuristic — it picks, among every ready operation and every machine it could use, the pairing that finishes soonest. Checked against precedence, machine non-overlap and valid machine choice before being written. |

Both are placeholders for demonstrating and testing the pipeline, not good schedules: the greedy
results sit 9–38% above the best known makespan for these instances. That gap is useful — it is
exactly what a real scheduler should be measured against (#158, #159).

A solution file is a JSON array of objects shaped like:

```json
[{ "instance": "abz5", "makespan": 1370, "solver": "greedy-spt", "date": "2026-09-06",
   "machine_0": [8, 9, 2, 4, 1, 3, 6, 0, 7, 5], "machine_1": [...] }]
```

Each `machine_N` lists **jobs in the order that machine works through them** — the sequencing
decision a scheduler makes. Everything else (which machine runs an operation, for how long) already
comes from the instance, so a solution only ever adds ordering.

A solution for a **flexible** instance uses the same shape, except the lists hold **operation ids**
rather than job ids, because the machine is now a decision too. Listing an operation under exactly
one machine states both facts at once — which machine it runs on, and where in that machine's queue.
Operation ids are globally unique, so this form also avoids the reentrancy ambiguity described
below.

That ordering becomes `schedule_dependencies` rows of two kinds: `job_order` (an operation waits for
the previous step of its own job) and `machine_queue` (an operation waits for whatever the machine
was doing before it). Resolving those two edge sets is what produces start times.

Because a sequence names *jobs*, it cannot express a schedule for a reentrant instance, where a job
visits the same machine more than once and "job 3 goes here" is ambiguous. Seeding rejects that case
with an explicit error rather than guessing — so `bel00` can never take a solution in this format.

Note the upstream benchmark repository publishes solution files too, but they contain only makespan
values and solver provenance — no sequences — so they cannot be replayed. They are useful as targets
for judging a scheduler, not as schedules.

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
