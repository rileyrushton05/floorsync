# Decisions

Use this folder to record important project decisions.

Decision records help explain why the team made particular design, technical, scope, or evaluation choices.

## Decision index

| Record | Status | Decision |
| --- | --- | --- |
| [0001](0001-celery-database-access.md) | Accepted | Process-local Celery database access |
| [0002](0002-backend-feature-organisation.md) | Accepted | Pragmatic feature-first backend organisation |
| [0003](0003-service-and-transaction-boundaries.md) | Accepted | Static service namespaces with caller-owned transactions |
| [0004](0004-typed-expected-outcomes.md) | Accepted | Typed expected outcomes with exhaustive handling |
| [0005](0005-initial-persistence-abstraction.md) | Accepted | Defer a repository abstraction for simple persistence |
| [0006](0006-production-middleware-and-observability.md) | Accepted | Production middleware and observability baseline |
| [0007](0007-local-jwt-authentication.md) | Accepted | Local JWT authentication with separate credentials |
| [0008](0008-route-declared-authorization.md) | Accepted | Route-declared role and machine authorization |
| [0009](0009-derived-simulation-timeline.md) | Accepted | Derived simulation timeline from one format-neutral resolver |
| [0010](0010-event-sourced-simulated-time.md) | Accepted | Simulated time derived by replaying the event log |
| [0011](0011-store-floorsync-start-times.md) | Accepted | Store the scheduler's own start times on schedule entries |
| [0012](0012-query-managed-frontend-server-state.md) | Accepted | TanStack Query-managed frontend server state |
| [0013](0013-scoped-schedule-generation.md) | Accepted | Scoped schedule generation refuses an incomplete job selection |
| [0014](0014-fajsp_milp_formulation.md) | Accepted | Single-shot MILP as a second, general-DAG-capable schedule generation strategy |
| [0015](0015-schedule-lifecycle-and-job-archival.md) | Accepted | Drafts are disposable, confirmed schedules are history, finished jobs are archived |
| [0016](0016-shared-input-validation.md) | Accepted | Validate production data once, apart from what each scheduler can take |

## Suggested Decision Record Format

```markdown
# Decision: [Short Decision Title]

## Date

[Date]

## Context

What issue, problem, or question was the team responding to?

## Decision

What did the team decide?

## Rationale

Why was this decision made?

## Alternatives Considered

What other options were considered?

## Consequences

What are the implications, risks, or trade-offs?
```

## Examples of Decisions to Record

- choosing a technology stack;
- changing the project scope;
- removing or adding a feature;
- changing the design direction;
- changing the database structure;
- changing the evaluation method; and
- responding to mentor, stakeholder, or user feedback.
