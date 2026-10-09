# Risk: Unhandled Edge Cases

## Description

Complex job and machine scenarios expose unhandled edge cases in the algorithm and simulation logic, leading to system crashes or incorrect outputs that could undermine user confidence.

## Likelihood

Medium (down from High)

## Impact

Medium

## Mitigation Plan

- Create a comprehensive test suite that includes a wide variety of job and machine configurations (e.g., jobs with no dependencies, jobs that require all machines, zero processing times)
- Use property-based testing to generate random scenarios and check for invariants
- Perform code reviews focused on boundary conditions
- Maintain a test case library from real user scenarios
- **(Checkpoint 2)** Done: multiple review rounds caught real bugs by running teammates' branches against a live Postgres instance rather than reading the diff (job-definition builder, operator dashboard, simulation playback), each fixed and reverified
- **(Checkpoint 2)** Remaining: fan-in is handled by the schema and the exact solver, but the ReSched adapter still refuses it, and whether fan-in stays in scope is an unresolved team decision (#216); reentrant-job handling is flagged as an open question against #138's definition of done

## Contingency Plan

- Implement robust error handling that catches exceptions and provides a meaningful error message to the user
- Log the failed state to allow developers to debug and fix the edge case
- Provide a "report bug" mechanism for users to submit problematic configurations

## Status

Monitoring