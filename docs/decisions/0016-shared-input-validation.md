# Decision: Validate production data once, apart from what each scheduler can take

## Date

2026-09-16

## Status

Accepted.

## Context

Whether a floor could be scheduled was only discoverable by asking for a schedule. The checks that
said no lived inside `ReSchedEngine._validate`, ran only during generation, and reported a
precedence cycle without naming the operations in it. When the exact solver arrived (decision
0014) it reimplemented a subset of the same checks in the worker task, differently. #133 asks for
the opposite: incomplete or contradictory production data reported before scheduling begins, each
problem naming the record at fault, through an endpoint the manager UI can call.

Two different questions had been folded into one list. Whether the data is coherent (every
operation has an active machine that can run it, durations are positive, the precedence graph has
no cycle, every reference resolves) is a property of the floor and is true or false for every
engine. Whether a given engine can take coherent data is a property of the engine: the pretrained
ReSched policy needs disjoint linear chains, and neither engine models machine downtime. Fan-in
(#216) is the case that made the difference visible: it is legitimate data, seeded on purpose, that
the exact solver schedules and ReSched refuses. Reporting it as an invalid floor was wrong.

## Decision

1. **Data coherence is checked once, in `scheduling/validation.py::validate_input`.** It takes the
   `SchedulingInput` snapshot every engine consumes and reports every problem at once, each naming
   its operation, machine or job where there is one. A cycle names every operation caught in it,
   via `find_dependency_cycle`.
2. **Every generation path runs it before its engine.** Both worker tasks refuse an incoherent
   floor with the same issues; the engines keep only their own limits. `ReSchedEngine._validate`
   delegates to the shared check and retains a defensive cycle guard because the runtime would
   loop on one.
3. **Engine limits are reported per strategy as unsupported, never as invalid.** Each engine
   states what it cannot take (`ReSchedEngine.unsupported`, `exact_strategy_limits`), and the
   report lists them under the strategy's name. `schedulable` is answered per strategy.
4. **Validation is available on demand.** `GET /api/v1/schedules/validation`, optionally scoped
   with `job_ids`, loads through `SchedulingService.load_input` so it sees exactly the snapshot a
   run would, selection refusals included, and always answers `200`: a floor with problems is a
   successful answer to "what is wrong". It writes nothing.
5. **Two facts the snapshot cannot show are warnings.** A job with no operations and an active
   machine nothing can run on leave no trace in the input; they are read from the database and
   reported as warnings, because they stop nothing and are probably mistakes.

## Rationale

- One rule with three callers cannot drift. The two engines already disagreed on which checks ran
  and how a cycle was described.
- "Unsupported by ReSched" is information a manager can act on (choose the other strategy);
  "invalid" is not, when the data is what the brief asked for.
- Loading through `load_input` means the endpoint and the worker can never disagree about what
  the floor contains, including archived jobs and the selection rules of decisions 0013 and 0015.

## Alternatives considered

- **Validate inside each engine and expose the ReSched checks as "the" validation**: rejected,
  because it makes ReSched's limits the definition of a valid floor and leaves the exact solver
  with a second copy.
- **A hard error for fan-in until #216 is settled**: rejected. The exact solver settles it in
  practice; a hard error would contradict a merged strategy and the seeded data.
- **Deriving warnings from the snapshot**: impossible for both cases, since the rows in question
  produce no operations or routes to inspect.
- **`POST /schedules/validations` with a JSON body**: rejected in favour of a `GET`, because
  validation is an idempotent read with no side effects, and the selection fits in a repeated
  query parameter.

## Consequences

- `SchedulingIssue` is the single shape for refusals, warnings and unsupported limits; only the
  list it appears in changes its meaning.
- Adding a strategy means adding its name to `validation.STRATEGIES` and its limits function;
  the data checks do not change.
- The scheduler page can disable Generate per strategy before queueing a run; that wiring is a
  frontend follow-up.
- `unavailabilities` has no API and both engines report it unsupported, so the table stays
  unused until a strategy models downtime.
