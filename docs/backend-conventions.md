# Backend conventions

These are the day-to-day implementation rules for FloorSync backend features. Decision records explain
why the rules exist; this page defines what new code is expected to do.

The terms **must**, **must not**, **should**, and **should not** are normative. A pull request that
needs an exception must explain it and, when it changes an architectural decision, update or supersede
the relevant decision record.

## Feature organisation

Product API code must be grouped by feature:

```text
floorsync_api/
├── features/
│   └── users/
│       ├── router.py
│       └── schemas.py
├── dependencies/
├── middleware/
├── problems.py
└── routers/api.py
```

- A feature router and its Pydantic HTTP schemas must live in the same feature package.
- Shared HTTP infrastructure must remain outside feature packages.
- SQLAlchemy models must live under `floorsync_common.database.models` and be imported by that
  package so Alembic discovers them.
- Shared application or domain code should be grouped by domain under `floorsync_common`, such as
  `floorsync_common.users` or `floorsync_common.scheduling`.
- `common` must not import `api` or `workers`.
- HTTP schemas must not be used as ORM models or passed into common services.

Operational transports such as health checks and WebSockets may remain under `routers/` because they
are not product feature slices.

## Service classes

- Stateless application operations must be exposed as static methods on a named service class.
- Service methods must have complete argument and return annotations.
- Service classes must not inherit from a generic `BaseService`.
- Static service classes must not contain mutable class state or use a service locator.
- FastAPI types, status codes, dependencies, and API schemas must not be imported into common
  services.

```python
class UserService:
    @staticmethod
    async def get_user(db: AsyncSession, user_id: UUID) -> GetUserResult:
        ...
```

When a service becomes difficult to navigate, split it by cohesive capability and expose the
separate implementation class as a namespace:

```python
class UserPersistenceService:
    @staticmethod
    async def create_user(...) -> CreateUserResult:
        ...


class UserService:
    Persistence = UserPersistenceService
```

- The subordinate class must be defined normally so it can be imported and tested independently.
- Do not lexically nest a large implementation class inside another class.
- Use capability names such as `Persistence`, `Validation`, or `Scheduling`.
- Split around responsibility, not an arbitrary line count.
- Class attributes used this way are class namespaces, not mutable singleton instances.
- Convert a service to an instance with constructor injection when it gains stateful collaborators
  such as a clock, scheduler, or external client.

## Sessions and transactions

- The API dependency owns request session lifetime.
- The route-level application operation owns the transaction.
- Celery tasks own their worker transaction through `worker_session_scope()`.
- The caller must pass the session explicitly into every database-using service.
- A service or repository must not create a hidden session, commit, or roll back.
- A helper may call `flush()` when it needs generated values or constraint evaluation.
- Every read and write must run inside an explicit transaction because autobegin is disabled.
- A session must not be shared between concurrent asyncio tasks, threads, or worker processes.

```python
async with db.begin():
    result = await UserService.create_user(db, email=email, display_name=name)
```

## Expected outcomes

- Expected not-found, refusal, validation, rule-violation, and no-op outcomes must be returned as
  concrete frozen, slotted dataclasses.
- Expected outcome classes must inherit from `floorsync_common.outcomes.ExpectedOutcome`.
- Each operation must declare a concrete union of every success and expected-outcome variant.
- A return union must not contain the marker base `ExpectedOutcome`.
- Consumers must handle concrete variants and end an exhaustive match with `assert_never()`.
- Business code must not handle `ExpectedOutcome` generically with `isinstance()` or a base-class
  pattern.
- Unexpected infrastructure failures, cancellation, programming errors, and broken internal
  invariants must still raise exceptions.

```python
type GetUserResult = UserFound | UserNotFound

match result:
    case UserFound(user=user):
        ...
    case UserNotFound(user_id=user_id):
        ...
    case _:
        assert_never(result)
```

An expected outcome is not automatically an error. HTTP status, log level, metrics, and retry
behaviour are selected for its concrete type at the relevant boundary.

## Persistence abstraction

- Services may use SQLAlchemy directly for simple, feature-local persistence.
- SQL statements must not appear in FastAPI routes.
- Do not introduce a generic CRUD repository or one repository per table by default.
- Extract a named query or repository when a query is reused, requires complex loading or locking,
  obscures the application operation, or needs separate async and synchronous implementations.
- Repositories must accept a caller-owned session and must not commit or roll it back.
- Services must return application results, not SQLAlchemy `Result` objects.

Prefer intention-revealing names such as `load_schedule_inputs()` over generic methods such as
`find_by()`.

## Pull-request checklist

- [ ] Feature HTTP code is colocated and does not leak into `common`.
- [ ] Request, update, and response schemas are separate from ORM models.
- [ ] The route contains no SQL and makes its transaction boundary visible.
- [ ] Services receive their session and never commit it.
- [ ] Expected outcomes are concrete typed variants handled exhaustively.
- [ ] Unexpected failures are not hidden inside a generic outcome.
- [ ] Database constraints back concurrency-sensitive invariants.
- [ ] Tests cover success, every expected outcome, rollback, and relevant database behaviour.

## Governing decisions

- [0002: backend feature organisation](decisions/0002-backend-feature-organisation.md)
- [0003: service and transaction boundaries](decisions/0003-service-and-transaction-boundaries.md)
- [0004: typed expected outcomes](decisions/0004-typed-expected-outcomes.md)
- [0005: initial persistence abstraction](decisions/0005-initial-persistence-abstraction.md)
