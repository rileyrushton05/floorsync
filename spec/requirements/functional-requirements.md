# Functional requirements

What FloorSync does. Sources and statuses are explained in the [overview](overview.md); CHG numbers
refer to [requirement-changes.md](requirement-changes.md).

**Summary:** 33 requirements. 22 delivered, 7 delivered with changes, 1 partly delivered,
3 not delivered.

## Production data

| ID | Requirement | Source | Status |
| --- | --- | --- | --- |
| FR-01 | A manager can add, edit, deactivate and remove machines, each with a unique name, an optional category and an optional operator salary. A machine with scheduled work can be deactivated but not removed. | Brief, CM1 | Delivered |
| FR-02 | A manager can create and delete machine categories, so the system fits any industry. | CM1 | Delivered |
| FR-03 | A manager can create, edit, duplicate and archive jobs, each with a name and a priority. Archived jobs are read-only. | Brief | Delivered |
| FR-04 | Each operation has one or more routes: a compatible machine with a duration in whole minutes and an optional energy figure. | Brief | Delivered |
| FR-05 | Operation order is a precedence graph. An operation can wait on several predecessors, and a change that would create a cycle is refused. | Brief, Team | Delivered |
| FR-06 | A manager can import machines, jobs and operations from a FloorSync JSON or ScheduleOpt benchmark file, preview it with a dry run, and nothing is written if any problem is found. | CM1 | Delivered |
| FR-07 | A developer can load any of 9 benchmark scenarios with one command, including confirmed schedules and one operator login per machine. | CP1 | Delivered with changes: benchmarks carry no categories or salaries |

## Scheduling

| ID | Requirement | Source | Status |
| --- | --- | --- | --- |
| FR-08 | Before generating, the system checks the selected data, reports every problem against the record at fault, and refuses to generate until it is fixed. | SoW, Team | Delivered |
| FR-09 | A manager selects open jobs in the Planner and generates a schedule in the background, with progress shown. | Brief, Team | Delivered |
| FR-10 | Every operation of every selected job is assigned to one compatible machine with a start and end time; precedence holds and no machine runs two operations at once. | Brief | Delivered |
| FR-11 | The manager can choose between two strategies, ReSched (fast, approximate) and Exact (slower, near-optimal). | SoW, CP2 | Delivered with changes (CHG-04) |
| FR-12 | A failed run explains why, and a partial result is never stored. | SoW | Delivered |
| FR-13 | Each schedule reports makespan, machine load, generation runtime, total energy and total labour cost. | SoW, CM1 | Partly delivered: runtime, energy and labour cost are returned by the API but not shown in the UI |
| FR-14 | Schedules move through draft, confirmed and withdrawn. Regenerating never overwrites a confirmed schedule, and a job can be in only one confirmed schedule at a time. | Brief, Team | Delivered |
| FR-15 | Schedules are optimised on a weighted combination of makespan, energy and operator salary. | CP1 | Not delivered: makespan only (CHG-05) |

## Simulation

| ID | Requirement | Source | Status |
| --- | --- | --- | --- |
| FR-16 | A manager can simulate a confirmed schedule. One simulation is active at a time, shared by every user. | Brief | Delivered |
| FR-17 | Playback can be started, paused, sped up (1x, 10x, 60x), scrubbed and reset, and completes at the makespan. | Brief, CM1 | Delivered with changes (CHG-20) |
| FR-18 | Machine, operation and job states are derived from the simulated clock and the stored schedule, so every view shows the same state. | Brief | Delivered |
| FR-19 | Changes reach every open dashboard without a refresh. | SoW | Delivered |

## Operator dashboard

| ID | Requirement | Source | Status |
| --- | --- | --- | --- |
| FR-20 | An operator sees only their machine: whether it is running, and the current operation with its expected start, end and time remaining. | Brief, CM1 | Delivered with changes: the machine is fixed by the login (CHG-02) |
| FR-21 | The operator sees the upcoming queue with expected times, and the operations already completed. | Brief, CM1 | Delivered |
| FR-22 | The operator sees the work left before a break, a countdown to the next break, and an on-break timer. | CM2 | Delivered |
| FR-23 | The operator can mark the current operation complete. | CP1 | Delivered with changes: kept in that browser only, not saved or shared |
| FR-24 | The operator can report an issue with their machine to the manager. | CP1 | Not delivered (CHG-11) |

## Manager dashboard and planning

| ID | Requirement | Source | Status |
| --- | --- | --- | --- |
| FR-25 | The Overview shows every machine running or idle with its current operation, and every job's progress with its current machine and next step, updated live. Administrative work lives on separate pages. | Brief, CM1, CP1 | Delivered |
| FR-26 | The manager can review a schedule as a Gantt chart with one lane per machine and trace one job across it. | Brief | Delivered |
| FR-27 | The Schedules page lists, filters and sorts every schedule and opens one in the simulation. | CP2 | Delivered |
| FR-28 | The manager can open any machine's operator view from the manager dashboard. | CM1 | Not delivered (CHG-19) |

## Accounts and access

| ID | Requirement | Source | Status |
| --- | --- | --- | --- |
| FR-29 | Users sign in with a username and password, get a 30-minute session and can sign out. | CM1 | Delivered with changes: username rather than email (CHG-17) |
| FR-30 | There are two roles, manager and operator, enforced on every API route. An operator can reach only their own machine. | SoW | Delivered |
| FR-31 | Every machine gets an operator login that managers can rename, reset or disable; the first manager is created from the command line. | CP2 | Delivered |

## Evaluation and delivery

| ID | Requirement | Source | Status |
| --- | --- | --- | --- |
| FR-32 | The strategies can be benchmarked against the baseline with one command, recording makespan, runtime and gap to the best known result. | SoW, CP1 | Delivered |
| FR-33 | The whole system runs locally from one command, and every pull request runs the full quality gate. | CP2 | Delivered with changes: no hosted deployment (CHG-10) |
