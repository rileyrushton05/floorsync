# Decision: Import a file straight into the floor's own tables, all of it or none of it

## Date

2026-10-06

## Status

Accepted. Recognising a job imported before is deferred to #299.

## Context

Pasindu asked for job, machine and operation data from another company to be importable, "mostly
via file upload", and said we keep our own setup tables regardless. Until now data entered the
database only one job at a time through the job builder, or through `make db-seed`, which deletes
the whole floor first and is for development only.

An import is the first time rows arrive from outside without a person choosing each one, so several
questions the builder never had to answer came up: what format a file is in, what happens to a
machine both the file and the floor have, what precedence a file means when it does not say, and
what a half-wrong file leaves behind. The team also discussed recognising a job imported before
(job names are deliberately not unique, and our UUIDs mean nothing to another system) and agreed
with Jason to leave that out of the first version: it needs an order-number column and a preview
UX of its own (#299).

## Decision

1. **One endpoint, `POST /api/v1/imports`**, manager only, taking a multipart file, with
   `?dry_run=true` for a preview. A real import answers `201` with the new job ids; a refused one
   answers a `422` Problem Details listing every issue; a dry run answers `200` with the same report
   either way. An import creates many resources and none is primary, so the `201` has no `Location`.
2. **Three formats, told apart by content**: FloorSync JSON (`"format": "floorsync"`,
   `"version": 1`), and the ScheduleOpt classic and flexible job-shop instances the seed loader
   already reads. The seed parsers are reused unchanged, so a benchmark imports the same way it
   seeds; benchmark machine names match the seed loader's, and jobs carry the instance name.
3. **Everything becomes ordinary rows** in `jobs`, `operations`, `compatibilities` and
   `dependencies`, the same rows the builder writes. No schema change and no import table. Every
   imported job is new and open in the backlog.
4. **Machines and categories are matched by exact name, reused, and never modified.** The floor's
   values win; a file that describes an existing machine differently gets a `machine_differs`
   warning, not an overwrite. A route may name a machine the file does not declare if the floor has
   it. A route to an inactive machine is refused, as the builder refuses one.
5. **A job that states no precedence runs its operations in the order listed**, written as
   `builder_sequence` edges: exactly the chain the builder derives from positions, so the builder
   can edit and even reorder the job afterwards. Stated precedence (`after`) is written as
   `external`, which the builder leaves alone. `after` may only name an operation listed earlier,
   so a cycle cannot be written and each position is simply the operation's place in the list:
   the builder chains a job by position on every save, and that chain can never contradict the
   stated precedence.
6. **All or nothing.** A file is read, checked against itself, then checked against the floor, and
   every problem is collected before anything is written, each naming its place in the file. The
   route commits only an applied, real import; it rolls back a dry run and every refusal.
7. **Concurrent imports share new machines rather than fail.** New machines and categories are
   inserted with `ON CONFLICT DO NOTHING` in name order, so a second import creating the same
   machine waits for the first, then reuses it, and reports it as reused. Its `machine_differs`
   warnings are judged against that machine as it then is, and a category it inserted only for
   the machine it did not get to create is removed again rather than left empty.
8. **The existing 1 MiB request limit bounds the file; count limits bound what it describes.**
   Every committed benchmark fits in 1 MiB (the largest, `behnke58`, is 583 KB with 9,748
   routes). The size alone is not enough: a classic benchmark declares its job and machine counts
   rather than listing them, so a few bytes can ask for millions. An import is refused
   (`too_large`) above 1,000 machines, 10,000 jobs, or 100,000 rows in total, checked before a
   declared count is expanded. The total counts every table the import writes, dependencies
   included: they grow with the square of a job's operations, so a 700 KB file can describe
   100,000 of them. A whole number too large for any field (`1e5000000`) is refused before it is
   converted. The largest committed benchmark is far below every limit.

## Rationale

- Writing into the existing tables is what Pasindu asked for, and it means everything downstream
  (backlog status, validation, generation, simulation) works on imported jobs without change. The
  integration tests check imported jobs against the same validation generation runs.
- Never modifying an existing machine keeps an import from silently changing the cost of work a
  confirmed schedule already planned.
- A file with problems is far more likely than a valid one on the first try, and a person fixing it
  by hand needs every problem at once, not one per upload. Hence collecting, not failing fast, for
  the FloorSync format; the benchmark parsers stop at the first problem, which is fine for files
  that come from an upstream benchmark set.
- The dry run exercises the real write path inside the transaction before rolling it back, so the
  preview cannot disagree with the import it previews.

## Alternatives considered

- **CSV or Excel**: closer to how a company may keep its data, but a flat sheet represents
  branching precedence awkwardly, and Excel needs a new dependency. Deferred; FloorSync JSON is
  additive to them later.
- **Updating existing machines (or jobs) from the file**: refused for machines (point 4); updating
  jobs needs to know a job was imported before, which is #299.
- **A separate import table recording each upload**: nothing needs it yet; the rows themselves are
  the record.
- **Reusing the job builder's create path per job**: it only writes straight chains, so it cannot
  carry a branching job; the import reuses its rules (active machines, no cycles) instead.
- **409 for a machine-name race**: correct but unhelpful; waiting and reusing gives the outcome the
  person wanted.
- **Accepting `after` in any order in a FloorSync file**: positions would then have to be numbered
  by a topological sort, and cycles detected and reported. We define this format, so requiring
  precedence to point forwards removes both. A flexible benchmark is someone else's format: its
  operation ids are labels, not an order, so its jobs are put into an order they can run in (a
  topological sort, lowest id first) and the seed parser has already refused a cycle.

## Consequences

- Re-importing a file adds its jobs again. Until #299 a person avoids that by checking the preview.
- Editing a branching imported job in the builder adds the builder's own position chain on save,
  which is how the builder treats any job; positions are chosen so that chain never contradicts the
  stated precedence.
- Operators, machine downtime and schedules are not imported. Operator logins should not arrive in
  a file, downtime has no API yet, and schedules are only seeded.
- Issue codes are part of the API contract and are listed in `docs/importing.md`.
