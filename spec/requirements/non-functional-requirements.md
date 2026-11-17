# Non-functional requirements

The quality attributes FloorSync was held to, and the measured result.

**Summary:** 12 requirements. 9 delivered, 3 partly delivered.

| ID | Attribute | Requirement | Result | Status |
| --- | --- | --- | --- | --- |
| NFR-01 | Performance | Generating never blocks the app; ReSched answers in seconds and Exact stops within a fixed budget. | ReSched took at most 0.6 s on 23 benchmark instances; Exact is capped at 120 s and runs on a background worker. | Delivered |
| NFR-02 | Solution quality | The team's scheduler measurably beats the baseline and stays close to the best known result. | Exact beat ReSched on 22 of 23 instances and tied 1 (14.9% shorter on average, up to 45%), with a mean gap of 0.11% to the best known makespan. See [benchmarks](../../evidence/benchmarks/). | Delivered |
| NFR-03 | Simulation fidelity | The simulation plays exactly the stored schedule. | Tests confirm the makespan, precedence and one operation per machine at a time. | Delivered |
| NFR-04 | Consistent live state | Every dashboard shows the same state, and no published change is lost. | One server clock drives every view and changes go through a transactional outbox. Gap: an operator's "Mark complete" is not shared. | Partly delivered |
| NFR-05 | Data integrity | Bad input never produces a bad schedule, and writes are all or nothing. | Input is validated before every generation and import; bad input returns a 422 naming the field. | Delivered |
| NFR-06 | Security | Only signed-in users with the right role can read or change data. | Argon2 password hashes, signed 30-minute tokens and role checks on every route, covered by 403 tests. | Delivered |
| NFR-07 | Usability | A first-time user completes the core tasks without help. | 17 of 18 recorded attempts were unassisted and mean SEQ was 5.7, but SUS was not recorded. See the [headline results](../../evidence/README.md#headline-results). | Partly delivered |
| NFR-08 | Accessibility | Status is never shown by colour alone, in light and dark themes. | Statuses carry text labels and both themes exist; small Gantt targets and no screen-reader announcements remain. | Partly delivered |
| NFR-09 | Maintainability | The code is consistent, typed, tested and its decisions recorded. | Lint, strict type checks and 829 backend tests run on every pull request, with 84% coverage ([testing evidence](../../evidence/testing/README.md)); 20 ADRs. | Delivered |
| NFR-10 | Deployability | Anyone with Docker can run the system with no verbal help. | `deployment/run-local.sh` starts everything in one command, tested from a fresh clone. | Delivered |
| NFR-11 | Generality | The system works for any manufacturer and takes data from other systems (CM1). | Free-form machine categories and import from FloorSync JSON and ScheduleOpt formats. | Delivered |
| NFR-12 | Privacy | Store as little personal data as possible (Team Charter). | Only names, usernames and password hashes are stored; all data is public benchmarks. | Delivered |
