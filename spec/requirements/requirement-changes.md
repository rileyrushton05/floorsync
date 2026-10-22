# Requirement changes

How the requirements moved from the course brief and the Statement of Work (14 Aug 2026) to what was
delivered (23 Oct 2026). Every change that added, altered or dropped a requirement is listed, with
when it happened, why, who decided and where it is recorded.

**Who decided:**
- **Client:** agreed with Pasindu Priyashan at a [client meeting](../../docs/meeting-notes/client-meetings.md) (CM1 on 27 Aug, CM2 on 9 Oct).
- **Team:** decided in a team meeting or on the board, and recorded in an ADR or a checkpoint report.

## Timeline

| Date | Milestone | Effect on scope |
| --- | --- | --- |
| 14 Aug | [Statement of Work](../statement-of-work/statement-of-work-and-team-charter.pdf) | Proposed a four-part MVP: scheduler, simulation, operator and manager dashboards, coordinator workflow; two strategies (a heuristic and a metaheuristic) benchmarked against a naive baseline |
| 27 Aug | Client meeting 1 | Fixed the scope boundaries: static day-before schedules, makespan first, categories, import, one operator per machine (CHG-01 to CHG-03, CHG-05 to CHG-07) |
| 31 Aug | Checkpoint 1 report | Recorded the changes from the Statement of Work and set the backlog |
| Sep | Build | Data-model and lifecycle decisions (CHG-12 to CHG-15); the second strategy came back (CHG-04) |
| 6 Oct | Checkpoint 2 report | Triaged rejected and deferred work and set the final Must, Should and Could plan |
| 9 Oct | Client meeting 2 | Added operator breaks (CHG-09) |
| 16 Oct | Feature freeze | Unfinished Should and Could items cut (CHG-19) |

## Changes

| ID | Date | Change | Why | Decided by | Record |
| --- | --- | --- | --- | --- | --- |
| CHG-01 | 27 Aug | **The production coordinator and the manager became one role.** The Statement of Work had a separate coordinator interface; schedule generation moved into the manager's pages. | Pasindu: the coordinator is the floor manager. | Client | CM1; Checkpoint 1; PR #127 |
| CHG-02 | 27 Aug | **Operator views are per machine, not per person.** One operator runs one machine per shift, on one laptop with one login per machine. | Pasindu: this is how operators work; the machine is the unit of work. | Client | CM1; Checkpoint 1; PRs #294, #312 |
| CHG-03 | 27 Aug | **Static, day-before scheduling.** No live schedule repair, disruption handling or machine downtime in scheduling. The `unavailabilities` table was kept for later, with no API, and both strategies refuse a selection whose machines have downtime. There is no "down" machine state. | Pasindu: schedules are made the day before, and live machine data is not available, so a static algorithm is enough. | Client | CM1; Checkpoint 1; Checkpoint 2, out of scope |
| CHG-04 | 31 Aug, then Sep and Oct | **Scheduling strategies.** The Statement of Work proposed a fast heuristic plus a metaheuristic. Checkpoint 1 cut this to one algorithm (#78 to #80 closed as not planned on 31 Aug). It was then reversed: ReSched (a pretrained learned policy provided by the supervisor) is the fast strategy, and the team built an Exact strategy, first a Gurobi MILP (#254), then logic-based Benders decomposition (#287, #326). | ReSched's schedules were up to 50% worse than optimal on benchmarks, and the day-before window left time for an exact method. The MILP slowed on large instances; the decomposition proved optima faster. | Team (Ben, with the project supervisor) | ADR 0014; Checkpoint 2, Early findings; PRs #254, #326 |
| CHG-05 | 27 Aug, then 6 Oct | **Optimisation objective.** The Statement of Work measured makespan and utilisation. Checkpoint 1 widened it to makespan, energy and operator salary. The final system optimises makespan only, and calculates and stores total energy and labour cost for each schedule without weighting them. | Pasindu: focus on makespan, with duration, energy and salary as cost factors. Weighting them into the objective was judged out of scope at Checkpoint 2. | Client, then Team | CM1; Checkpoint 2, Rejected (#69, #139) |
| CHG-06 | 27 Aug | **Machine categories added**, so the system is general-purpose rather than glass-cutting specific. | Pasindu: it must adapt to other industries. | Client | CM1; PRs #322, #324 |
| CHG-07 | 27 Aug | **Import from a file added.** Jobs, machines and operations from another company's system, mostly by file upload, alongside FloorSync's own tables. | Pasindu requested it. | Client | CM1; ADR 0020; PRs #300, #330, #332 |
| CHG-08 | 31 Aug | **Dashboards show simulated state, not live machine data.** | Live machine integration is not available and is outside the project. | Team | Checkpoint 1 |
| CHG-09 | 9 Oct | **Operator breaks added.** The operator page shows continuous work left until a break, a countdown, and an on-break timer. Breaks are the idle gaps in the machine's schedule, so nothing new is stored. | Pasindu: the main thing operators need is to know when they can take a break. | Client | CM2; PR #323 |
| CHG-10 | 5 Oct | **Hosted deployment dropped.** A one-Droplet deployment with Jenkins (#220 to #226) was replaced by GitHub Actions for CI and local Docker Compose for running the system. | GitHub Actions and Docker Compose covered everything the team needed, and a public server was not required. | Team | Checkpoint 2, Rejected; [deployment](../../deployment/README.md) |
| CHG-11 | 19 Oct | **Operator issue reporting descoped.** The early prototype had a "Report issue" button that only showed a message. A real version (#315) needed decisions on what a report contains, who is told and whether it changes the schedule. | No time to make and build those product decisions after user testing raised it. | Team | #315 (closed as not planned); Checkpoint 2, Limitations |
| CHG-12 | Late Aug to Sep | **Precedence is between operations, not jobs.** Jobs are independent; an operation can wait on several predecessors (fan-in), including in another job. | The team's data-model design; real assembly work has fan-in. | Team | ER diagram #125; PRs #238, #240, #263 |
| CHG-13 | 10 Sep | **Schedule start times are stored, not derived.** Reverses the earlier "derive, don't store" decision (ADR 0009). | The scheduler already produces each start time, so storing it once removes a second calculation; testing showed stored and derived times agreed exactly. | Team | ADR 0011; PRs #228, #252 |
| CHG-14 | Sep | **Generation is scoped to selected open jobs, and a job's status is derived from its schedules.** Archiving jobs automatically on generation (#266) was rejected. | The manager plans part of the backlog at a time, and a stored status could drift from the schedules. | Team | ADR 0013, 0019; PRs #257, #273 |
| CHG-15 | Oct | **Only confirmed schedules can be simulated.** | So the floor only ever follows a plan the manager approved. | Team | ADR 0015; Checkpoint 2, Final delivery plan C; PR #295 |
| CHG-16 | 5 Oct | **Recognising previously imported jobs deferred.** An import always adds new jobs. | Duplicate handling needs its own design and UI, and was not needed for a first version. | Team | ADR 0020; #299 |
| CHG-17 | Early Sep | **Sign-in uses a username rather than an email address.** | Operator logins belong to machines, and the credential model does not assume every account has an email address. | Team | ADR 0007 |
| CHG-18 | 6 Oct | **No separate admin role.** Managers manage operator logins; the first manager is created from the command line. | Out of scope for the prototype. | Team | Checkpoint 2, Out of scope; `scripts/create_manager.py` |
| CHG-19 | 16 Oct | **Not built by the feature freeze:** opening a machine's operator view from the manager dashboard (CM1); bottleneck flags on the manager view (Statement of Work); schedule comparison, schedule export and first-run guidance (Checkpoint 2, Should); an acknowledgement step before confirming a schedule with warnings (Checkpoint 2, Must). The Statement of Work's stretch goals (priority re-weighting, CSV export, an AI recommendation layer) were not started. | Time. Checkpoint 2 set the rule that unfinished items are cut at the freeze and recorded. The Overview and Simulation pages already show each machine's current and next work, which covers most of what the drill-down was for. | Team | Checkpoint 2, Final delivery plan |
| CHG-20 | Sep | **Simulation speeds are 1x, 10x and 60x with scrubbing**, rather than one fixed accelerated speed (CM1 suggested 20x). | A choice of speeds suits both watching and demonstrating a full day; scrubbing was added after user testing (Checkpoint 2, finding F10). | Team | PRs #283, #295 |
| CHG-21 | 6 Oct | **The evaluation baseline is ReSched**, rather than a naive or manual schedule built by the team. | ReSched was the policy Pasindu provided as the project's baseline algorithm, so the team's solver is measured against it on identical input. | Team | Checkpoint 2, Risk records; [evidence/benchmarks](../../evidence/benchmarks/) |
