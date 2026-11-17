# Evidence

Evidence of how FloorSync was evaluated. Each folder below explains its own
contents.

| Folder or file | What it shows |
| --- | --- |
| [benchmarks/](benchmarks/) | The scheduling evaluation: ReSched (baseline), the first Gurobi MILP and the final Exact solver (CP-LBBD) on 23 standard instances. [`results_for_solver.csv`](benchmarks/results_for_solver.csv) has makespan, runtime and gap to the best known result for every run; the two charts plot makespan and runtime. Run on 11 Oct 2026 with a 600 s limit per solver per instance. |
| [testing/](testing/README.md) | How the backend is tested and the last full run: 828 passed, 1 skipped, 84% coverage, with the integration tests run against real PostgreSQL and Redis. |
| [traceability.md](traceability.md) | Each usability or testing finding traced to its ticket, the change that dealt with it and the test that covers it. |

## Headline results

- **Scheduling:** Exact beat the ReSched baseline on 22 of 23 instances and tied 1, with a 14.9%
  shorter makespan on average (up to 45%) and a mean gap of 0.11% to the best known result.
  ReSched answered in at most 0.6 s.
- **Usability:** 17 of 18 recorded tasks completed unassisted (94%) and a mean SEQ of 5.7 against
  a target of 5.5, across four moderated sessions with students outside the team. SUS was not
  recorded. The session records are not included in this repository.

How these results meet the brief's success criteria is in
[spec/requirements/overview.md](../spec/requirements/overview.md#success-criteria-from-the-brief).

## Related records

- [Decision records](../docs/decisions/README.md) and the [risk register](../docs/risks/README.md)
- How the interface changed over time in [design/](../design/README.md)
