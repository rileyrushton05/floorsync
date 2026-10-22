# Requirements overview

Who FloorSync is for, the brief's success criteria and how each was met, and the scope, constraints
and assumptions. Checked against the code on `main` for the final submission (23 October 2026).

## Sources

The Source column in the requirement tables uses these abbreviations:

- **Brief:** the [course brief](../project-brief.png) for project 13.
- **SoW:** the [Statement of Work](../statement-of-work/statement-of-work-and-team-charter.pdf) (14 Aug).
- **CM1, CM2:** [client meetings](../../docs/meeting-notes/client-meetings.md) with Pasindu Priyashan (27 Aug, 9 Oct).
- **CP1, CP2:** the Checkpoint 1 and 2 reports (31 Aug, 6 Oct).
- **Team:** a team decision recorded on the board or in an ADR.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Delivered | Built and working as specified. |
| Delivered with changes | The need is met, but the requirement changed on the way. |
| Partly delivered | Some of it works; what is missing is named. |
| Not delivered | Dropped or deferred; the reason is in [requirement changes](requirement-changes.md). |

## Users and stakeholders

| Who | Role |
| --- | --- |
| Production manager | Manages machines and jobs, generates and confirms schedules, runs the simulation and monitors the floor. Pasindu confirmed the production coordinator is the same person. |
| Machine operator | Signs in at one machine and sees its current operation, queue, expected times and breaks. |
| Pasindu Priyashan, Zentinext | External contact; set scope priorities and reviewed the prototype twice. |
| Teaching staff | Assess the prototype and the evidence. |

## Success criteria from the brief

All eight are met.

| # | Success criterion | Status | How it is met | Requirements |
| --- | --- | --- | --- | --- |
| SC1 | A scheduling algorithm that assigns every operation to a compatible machine with start and end times, respecting precedence | Delivered | Two strategies, ReSched and the team's Exact solver, both placing every operation on a compatible machine with no overlaps. | FR-08 to FR-14 |
| SC2 | A time-driven simulation in real or accelerated time | Delivered | One server-side clock with play, pause, 1x to 60x speeds, scrubbing and reset. | FR-16 to FR-19 |
| SC3 | An operator dashboard with the current operation, queue and expected times | Delivered | The operator page shows these for the signed-in machine, plus breaks. | FR-20 to FR-22 |
| SC4 | A manager dashboard with every machine's status and every job's progress | Delivered | The Overview and Simulation pages show both, updated live. | FR-25, FR-26 |
| SC5 | A sequential pipeline, with operator and manager views on the same simulation state | Delivered | Generate, confirm, simulate, monitor; both views follow one server clock. Limitation: "Mark complete" is not shared (NFR-04). | FR-14, FR-16, FR-19 |
| SC6 | A usable workflow for a coordinator to build and hand off a schedule | Delivered | Jobs or Import, then Planner, confirm, Simulation; completed by every participant with a recorded result in user testing. | FR-06, FR-09, FR-14 |
| SC7 | Justified algorithm decisions, including the quality and computation time trade-off | Delivered | ReSched answers in under a second but is approximate; Exact takes up to 120 s and matches the best known result on 18 of 23 instances (ADR 0014). | NFR-01, NFR-02 |
| SC8 | Evaluation showing measurable improvement over a naive or manual baseline | Delivered | On 23 benchmark instances, Exact beats the ReSched baseline on 22 and ties 1, 14.9% shorter on average ([benchmarks](../../evidence/benchmarks/)). | NFR-02 |

## Scope

**In scope:** the data model and its management pages, file import, benchmark seeding, validation,
two scheduling strategies, the schedule lifecycle, a shared simulation, live updates, both
dashboards, sign-in with two roles, and a benchmark evaluation.

**Out of scope** (see [requirement changes](requirement-changes.md)): live schedule repair, machine
downtime in scheduling, a combined cost objective, operator issue reporting, a hosted deployment,
recognising previously imported jobs, and the Statement of Work's stretch goals.

## Constraints

| ID | Constraint | Source |
| --- | --- | --- |
| C1 | Schedules are generated the day before and are not repaired live. | CM1 |
| C2 | The system stays general-purpose, not specific to one industry. | CM1 |
| C3 | One operator runs one machine per shift, with one login per machine. | CM1 |
| C4 | Simple username and password authentication is enough. | CM1 |
| C5 | Dashboard state comes from the simulation, not live machine data. | CP1 |
| C6 | Runs locally on Docker Compose; there is no hosted environment. | CP2 |
| C7 | The Exact strategy needs a Gurobi licence, which cannot be shipped in the repository. | Gurobi licensing |
| C8 | One semester, six people, about 10 hours each per week. | Team Charter |

## Assumptions

| ID | Assumption |
| --- | --- |
| A1 | Durations are whole minutes; every benchmark duration is an integer. |
| A2 | Idle time between operations is expected, and an operator's breaks are those idle gaps (CM1, CM2). |
| A3 | Jobs are independent; ordering is between operations, which may wait on several predecessors. |
| A4 | Public benchmark instances are realistic enough to evaluate schedule quality; no real factory data was available. |
| A5 | Usability participants were students, so results show learnability rather than fit with real factory work. |
