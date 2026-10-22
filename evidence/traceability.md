# Traceability: testing findings to changes and tests

This table follows each finding from where it was found, to the ticket and change that dealt with it, to the evidence that the change works. A finding with no automated test says so. Participants are identified by ID only. Test method and results are in `user-testing/`, and the technical test run is in `testing/`.

Status key: **Fixed** (change merged), **Open** (not done yet), **Descoped** (decided not to build, with the reason recorded on the ticket).

## Usability testing findings

Source: four moderated sessions (P1 group, P2 to P4 individual), recorded in `user-testing/user-testing-results.md`.

| Finding | Found by | Ticket | Change | Automated test | Status |
|---|---|---|---|---|---|
| Operators had no way to report a machine issue (T2 could not be run) | P1 to P4 | #315 | None. The team decided issue reporting is out of scope, and the ticket was closed on 19 Oct with that comment | None | Descoped |
| Manager view offered to a signed-in operator, which redirects back | Testing | #316 | Commit `db2b824` (`RequireOperator`), closed 19 Oct | None (no frontend tests); access is enforced server-side and covered by `test_auth.py` | Fixed, not re-tested |
| A machine had to exist before a job could use it | P1, P2 | None | PR #325, create machines from the job editor | None | Fixed, not re-tested |
| Add buttons hard to find (P4 could not find "add operation") | P2, P4 | None | PR #327, tidied New Job / Machine / Schedule buttons | None | Fixed, not re-tested |
| Overview: Today's Jobs links and machine overview did not work, "View all machines" did nothing | Manager walkthrough | None | PR #311, live overview page | None | Fixed, not re-tested |
| Renaming a job in the job builder returned a server error | P2 | #308 | PR #309 | `tests/integration/test_values_computed_on_update.py`, `tests/backend/test_job_definitions_api.py` | Fixed |
| Makespan, Exact and ReSched not understood (P4 needed a hint) | P3, P4 | [NOT TICKETED] | None yet | None | Open |
| Unclear whether Mark Complete starts the next operation | P3, P4 | [NOT TICKETED] | None yet | None | Open |
| Logged out automatically while still working | P2 | [NOT TICKETED] | None yet | None | Open |

## Technical testing findings

| Finding | Evidence | Ticket | Change | Automated test | Status |
|---|---|---|---|---|---|
| ReSched schedules were up to 50% above the best-known makespan on benchmark instances | `benchmarks/results_for_solver.csv`: ReSched mean gap 19.6% over 23 instances | #250 | Exact solver wired into schedule generation | `test_gurobi_exact_solver.py`, `test_seed_solutions.py` | Fixed |
| The full MILP often hit its time limit without proving optimality | Gurobi mean gap 2.3%, proven optimal on 13 of 23 | #317, #318 | PR #326, CP-LBBD replaces Benders | `test_fjsp_lbbd.py`, `test_gurobi_exact_solver.py` | Fixed: mean gap 0.1%, 18 of 23 optimal |
| A persisted simulation change could be lost before reaching dashboards | Design risk, recorded in ADR 0017 | #148, #288, #292 | Transactional outbox, relay, authenticated websocket transport | `tests/integration/test_live_update_outbox.py`, `test_live_update_delivery.py`, `test_live_update_restart.py`, `test_live_update_cross_instance.py` | Fixed; recovery after a Redis restart is tested against real Postgres and Redis |
| Bad production data could reach a schedule | Import validation design | #296, #297 | Import checks and dry-run preview | `test_import_checks.py`, `test_import_formats.py`, `tests/integration/test_data_import.py` | Fixed |

## Not covered

- No automated frontend tests, so no automated evidence for the frontend rows above. They rely on the usability sessions.
- Most usability fixes have not been re-tested with participants.
- Task T2 (report an issue) could not be tested because issue reporting was descoped.
- SUS was not collected.
- Failure cases for live updates other than a Redis restart (for example a dropped connection) are not tested.
