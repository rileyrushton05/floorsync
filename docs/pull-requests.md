# Pull Request Guide

PRs are not just a merge mechanism: they are evidence of collaborative development and a safeguard against late integration surprises.

## Author checklist

- [ ] The PR has a linked GitHub issue and satisfies its acceptance criteria.
- [ ] The change is focused; unrelated refactors or formatting are in separate PRs.
- [ ] Tests/checks have been run, or the reason they cannot yet run is stated.
- [ ] Setup, architecture, risks or decision records are updated if the change affects them.
- [ ] Screenshots or a short recording are included for visible UI behaviour.
- [ ] Known limitations, technical debt and follow-up work are stated and captured as issues.
- [ ] The PR is small enough that a teammate can understand and review it.

## Reviewer checklist

- [ ] The change meets the linked issue’s acceptance criteria.
- [ ] It fits the agreed architecture, domain model and API/state contracts.
- [ ] Tests/checks meaningfully cover the changed behaviour.
- [ ] The implementation is understandable and does not introduce avoidable duplication or hidden assumptions.
- [ ] Documentation and evidence are accurate.
- [ ] Any deferred work is recorded in a new or existing issue.

## Review expectations

- Aim to review within one working day when possible.
- Give actionable feedback; explain the risk or question rather than writing vague comments.
- Use approval only when you would be comfortable demonstrating the change to a tutor or stakeholder.
- If the PR changes a shared contract, data model or project scope, request review from the relevant owner before approval.
