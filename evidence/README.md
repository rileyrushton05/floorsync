# Evidence

Evidence of how FloorSync was evaluated and who built what. Each folder below explains its own
contents.

| Folder or file | What it shows |
| --- | --- |
| [benchmarks/](benchmarks/) | The scheduling evaluation: ReSched (baseline), the first Gurobi MILP and the final Exact solver (CP-LBBD) on 23 standard instances. [`results_for_solver.csv`](benchmarks/results_for_solver.csv) has makespan, runtime and gap to the best known result for every run; the two charts plot makespan and runtime. Reproduce with `scripts/bench_resched_vs_benders.py`. |
| [testing/](testing/README.md) | How the backend is tested and the last full run: 828 passed, 1 skipped, 84% coverage, with the integration tests run against real PostgreSQL and Redis. |
| [user-testing/](user-testing/README.md) | The usability test plan, moderator script and the results of four moderated sessions (P1 to P4), with task completion and SEQ scores. |
| [traceability.md](traceability.md) | Each usability or testing finding traced to its ticket, the change that dealt with it and the test that covers it. |
| [weekly-contribution/](weekly-contribution/README.md) | The team's weekly contribution reviews (weeks 3 to 11), one section per member with the pull requests and issues behind each claim. |
| [ai-prompts/](ai-prompts/README.md) | Each member's exported AI prompt log, supporting the [AI-use declarations](../ai-declarations.md). |

## Headline results

- **Scheduling:** Exact beat the ReSched baseline on 22 of 23 instances and tied 1, with a 14.9%
  shorter makespan on average (up to 45%) and a mean gap of 0.11% to the best known result.
  ReSched answered in at most 0.6 s.
- **Usability:** 17 of 18 recorded tasks completed unassisted (94%) and a mean SEQ of 5.7 against
  a target of 5.5. SUS was not recorded.

How these results meet the brief's success criteria is in
[spec/requirements/overview.md](../spec/requirements/overview.md#success-criteria-from-the-brief).

## Contribution evidence elsewhere

- Commits, pull requests and reviews on [GitHub](https://github.com/Studio3Build-2026s2/team-61-cuffington-and-co/pulls?q=is%3Apr)
- The [project board](https://github.com/orgs/Studio3Build-2026s2/projects/64) of epics, features, stories and tasks
- [Meeting notes](../docs/meeting-notes/README.md), [decision records](../docs/decisions/README.md) and the [risk register](../docs/risks/README.md)
- How the interface changed over time in [design/](../design/README.md)
