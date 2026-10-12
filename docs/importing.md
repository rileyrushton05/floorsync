# Importing production data

A manager can add machines, jobs and operations from a file instead of building each job by hand
(#297, decision [0020](decisions/0020-file-import-into-the-floor.md)). The file lands in the same
tables the job builder writes to: every imported job is new and open in the backlog, ready to be
selected for a schedule.

A file with any problem imports nothing, and the response lists every problem with where it is in
the file. Check a file first with a dry run.

One upload finds every shape problem (a missing field, a wrong type) and every value problem in the
machines and jobs whose shape is fine. Checks against the floor, such as whether a named machine
exists, need the whole file to be well-formed, so they appear once the shape problems are fixed.

## The endpoint

```bash
# Preview: what the file would add, and anything wrong with it. Nothing is kept.
curl -X POST "http://localhost:8002/api/v1/imports?dry_run=true" \
  -H "Authorization: Bearer $TOKEN" -F "file=@docs/examples/import-example.json"

# Import it.
curl -X POST "http://localhost:8002/api/v1/imports" \
  -H "Authorization: Bearer $TOKEN" -F "file=@docs/examples/import-example.json"
```

| Request | Answer |
| --- | --- |
| Dry run | `200` with a report, whether or not the file has problems |
| Import, file fine | `201` with the same report and the new `job_ids` |
| Import, file has problems | `422` Problem Details (`urn:floorsync:problem:import-invalid`) with `issues` and `warnings` |
| File over 1 MiB | `413` |
| Not a manager | `403` |

The report:

```json
{
  "format": "floorsync",
  "dry_run": true,
  "importable": true,
  "summary": {
    "machines_created": ["Cutting Table 1", "Cutting Table 2"],
    "machines_reused": ["Edge Polisher"],
    "categories_created": ["Cutting"],
    "jobs": 3, "operations": 10, "routes": 11, "dependencies": 7
  },
  "job_ids": [],
  "issues": [],
  "warnings": [
    {
      "code": "resched_unsupported",
      "message": "Job 'Laminated door panel' has an operation that waits on ...",
      "location": "jobs[2]"
    }
  ]
}
```

`summary` is null when the file could not be read at all. `location` points into the file
(`jobs[1].operations[0].routes[0].duration`), or is null for the file as a whole.

## The FloorSync format

[`docs/examples/import-example.json`](examples/import-example.json) is a complete example; it is
imported by the integration tests, so it always works.

```json
{
  "format": "floorsync",
  "version": 1,
  "machines": [{ "name": "Saw 1", "category": "Cutting", "salary": 38.5 }],
  "jobs": [
    {
      "name": "Shower screen",
      "priority": "high",
      "operations": [
        { "name": "Cut", "routes": [{ "machine": "Saw 1", "duration": 20, "energy": 3.5 }] },
        { "name": "Polish", "routes": [{ "machine": "Polisher", "duration": 35 }] }
      ]
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | yes | Always `"floorsync"` |
| `version` | yes | Always `1` |
| `machines` | no | Machines to create if the floor does not have them |
| `machines[].name` | yes | Matched against the floor's machines by exact name |
| `machines[].category` | no | Category name, created if it does not exist |
| `machines[].salary` | no | Labour cost of running the machine, 0 to 99,999,999.99, at most two decimals |
| `jobs` | yes | At least one job |
| `jobs[].name` | yes | Free text; two jobs may share a name |
| `jobs[].priority` | no | `high`, `med` or `low`; `med` when left out |
| `jobs[].operations` | yes | At least one operation |
| `operations[].name` | yes | Unique within the job when the job uses `after` |
| `operations[].routes` | yes | At least one machine the operation can run on |
| `operations[].after` | no | Names of earlier operations in the same job that this one waits for |
| `routes[].machine` | yes | A machine declared in the file or already on the floor |
| `routes[].duration` | yes | Whole minutes, at least 1 |
| `routes[].energy` | no | 0 to 99,999,999.99, at most two decimals |

Names are trimmed. Unknown fields are refused, so a typo such as `"priorty"` is caught rather than
ignored.

### Precedence

- **No `after` anywhere in a job**: its operations run in the order listed, one after another. This
  is the chain the job builder makes, and the builder can edit and reorder the job later.
- **Any `after` in a job**: only what is stated. An operation without `after` (or with `"after": []`)
  waits for nothing, and an operation can wait for several. A job like that is a general precedence
  graph: the exact solver can schedule it, ReSched cannot, and the import warns about it.

`after` names operations listed earlier in the same job, so list a job's operations in an order
they can run in. Each operation's position in the job is its place in the list.

### Machines

Machines are matched by exact name. A machine the floor already has is reused and **never
changed**: if the file gives it a different category or salary, the floor's values are kept and the
import warns. A route may name a machine the file does not declare, as long as the floor has it. A
route to an inactive machine is refused.

Every machine the import creates gets its operator login, exactly as one created through
`POST /machines` does: a username from the machine's name (`Cutting Table 1` becomes
`cutting-table-1`) and the configured default password (`OPERATOR_DEFAULT_PASSWORD`). A reused
machine keeps the login it already has. A dry run creates none.

## Benchmark files

ScheduleOpt classic job-shop and flexible job-shop instances (the files in
`src/database/seed-data/`) import as they are. Machines are named as the seed loader names them
(`abz5/M3`), so importing an instance the database was seeded with reuses its machines; jobs are
named after the instance (`abz5/J7`). A classic job is a straight chain; a flexible job keeps its
precedence edges, branching included, and its operations are listed in an order they can run in
whatever their ids.

Unlike `make db-seed`, an import never deletes anything.

A classic instance's `jobs` and `machines` are counts the file declares rather than lists it
contains, so a file of a few bytes can declare millions. Those counts are checked against the
`too_large` limits before anything is built from them.

## Issue codes

| Code | Meaning |
| --- | --- |
| `empty_file`, `not_utf8`, `not_json`, `duplicate_key`, `too_deeply_nested`, `not_an_object` | The file could not be read as one JSON object |
| `unknown_format` | Neither a FloorSync file nor a benchmark |
| `unsupported_version` | A FloorSync `version` other than 1 |
| `invalid_benchmark` | A benchmark file the seed parsers refuse; the message says why |
| `too_large` | More than one import can add: 1,000 machines, 10,000 jobs, or 100,000 rows in total (machines, categories, jobs, operations, routes and dependencies) |
| `missing_field`, `unknown_field`, `wrong_type` | A FloorSync field is missing, not allowed, or the wrong type |
| `invalid_value` | A value out of range, blank, or with too many decimals |
| `duplicate_machine` | The file declares a machine twice |
| `duplicate_route` | An operation lists the same machine twice |
| `duplicate_operation_name` | Two operations share a name in a job that uses `after` |
| `unknown_predecessor`, `duplicate_dependency` | A bad name in an `after` list |
| `predecessor_not_earlier` | An `after` names the operation itself or one listed after it |
| `unknown_machine` | A route names a machine neither the file nor the floor has |
| `inactive_machine` | A route names a machine that is inactive on the floor |

Warnings never stop an import:

| Code | Meaning |
| --- | --- |
| `machine_differs` | The file describes an existing machine differently; the floor's values are kept |
| `similar_machine_name` | A new machine's name matches an existing one except for capitalisation |
| `resched_unsupported` | A job branches, so only the exact solver can schedule it |

## Not imported

- **Operators and logins**: passwords should not travel in a file. New machines get their login
  as described under Machines; a manager changes its password afterwards.
- **Machine downtime**: `unavailabilities` has no API yet.
- **Schedules**: only the seed loader writes a pre-solved schedule.
- **Recognising a job imported before**: importing the same file twice adds its jobs twice. Check
  the dry run first; order numbers and duplicate detection are #299.
