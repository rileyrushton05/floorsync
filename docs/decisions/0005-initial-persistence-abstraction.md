# Decision: Defer a repository abstraction for simple persistence

## Date

2026-09-02

## Status

Accepted

## Context

The first product operations are simple creates and primary-key lookups. Introducing a repository
class for every model would initially repeat SQLAlchemy's `get`, `add`, `select`, and `flush` APIs
without hiding meaningful complexity. At the same time, routes should not accumulate SQL queries and
complex query behaviour will eventually deserve named, independently testable components.

## Decision

1. Permit a common service implementation to use SQLAlchemy directly for simple operations.
2. Keep SQL statements out of FastAPI routes.
3. Do not introduce generic `BaseRepository`, generic CRUD service, or one repository class per table.
4. Extract a named query or repository component when at least one of these conditions applies:
   - a query is reused by multiple application operations;
   - loading requires non-trivial joins, eager-loading, pagination, or locking;
   - persistence code obscures the business operation;
   - the same domain operation needs distinct async API and synchronous worker adapters;
   - a test needs a meaningful persistence boundary rather than a mock of SQLAlchemy internals.
5. Repositories, when introduced, receive a caller-owned session and never commit or roll back it.

## Rationale

- SQLAlchemy's session already provides identity-map and unit-of-work behaviour.
- Premature generic repositories tend to leak SQLAlchemy while also hiding useful query semantics.
- Named queries such as `load_schedule_inputs()` communicate more than generic methods such as
  `repository.find_by()`.
- Deferring the abstraction keeps the first vertical slice small while preserving a clear extraction
  path.

## Alternatives considered

- **Repository per ORM model from the first feature:** consistent in appearance, but mostly delegates
  one-to-one to SQLAlchemy for current operations.
- **Generic CRUD repository:** rejected because different aggregates have different loading,
  authorization, concurrency, and deletion rules.
- **SQL directly in routes:** rejected because it mixes HTTP transport and persistence concerns.
- **Always mock the database behind a repository:** rejected because database constraints and query
  behaviour require integration testing against PostgreSQL regardless.

## Consequences

- Initial services may import `AsyncSession`, SQLAlchemy statements, and ORM models.
- A service still exposes application results rather than raw SQLAlchemy `Result` objects.
- Extraction is based on demonstrated complexity instead of a fixed number of files or tables.
- PostgreSQL integration tests remain necessary even after repositories are introduced.
