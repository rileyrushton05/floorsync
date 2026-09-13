# Decision: Static service namespaces with caller-owned transactions

## Date

2026-09-02

## Status

Accepted

## Context

FloorSync needs a consistent place for application operations that coordinate validation and
persistence without coupling domain code to FastAPI. The team prefers readable call sites such as
`UserService.create_user(...)`. The API already creates one asynchronous SQLAlchemy session per
request with implicit transaction creation disabled.

Allowing each service method to obtain and commit its own session would hide transaction boundaries.
It would also prevent a caller from composing multiple service operations into one atomic unit.

## Decision

1. Expose related stateless application operations as static methods on a named service class, for
   example `UserService.create_user(db, ...)`.
2. Do not instantiate a service class while it is only a namespace for stateless operations. Do not
   introduce a `BaseService` hierarchy.
3. The caller supplies the SQLAlchemy session explicitly. A service must not read the global session
   factory or create a hidden session.
4. The transport or task boundary owns session lifetime. The route-level application operation or
   Celery task owns the transaction.
5. Service methods may query, add, update, delete, and flush. They must not commit or roll back a
   caller-owned transaction.
6. HTTP routes translate Pydantic inputs into service arguments and service results into HTTP
   responses. Common services must not import FastAPI, HTTP status codes, or API schemas.
7. If a service later needs collaborators such as a scheduler, clock, or external client, convert it
   to an instance with explicit constructor injection rather than adding global state.
8. If a service class becomes too large, split coherent groups of operations into separately defined
   subordinate service classes and expose them as named class attributes on the primary service. This
   preserves one discoverable public namespace without keeping every implementation in one class or
   file.

```python
class UserService:
    @staticmethod
    async def create_user(
        db: AsyncSession,
        *,
        email: str,
        display_name: str,
    ) -> CreateUserResult: ...
```

```python
async with db.begin():
    result = await UserService.create_user(
        db,
        email=payload.email,
        display_name=payload.display_name,
    )
```

For example, persistence operations may be moved into their own class while remaining discoverable
through `UserService`:

```python
class UserPersistenceService:
    @staticmethod
    async def create_user(
        db: AsyncSession,
        *,
        email: str,
        display_name: str,
    ) -> CreateUserResult: ...


class UserService:
    Persistence = UserPersistenceService

    @staticmethod
    def normalize_display_name(display_name: str) -> str:
        return display_name.strip()
```

The resulting call site remains feature-oriented:

```python
result = await UserService.Persistence.create_user(
    db,
    email=payload.email,
    display_name=payload.display_name,
)
```

Subordinate classes are defined normally and then aliased onto the primary service. Do not define
large classes lexically inside other classes. A subnamespace must represent a cohesive capability
such as `Persistence`, `Validation`, or `Scheduling`, not merely a way to avoid a long file.

## Rationale

- The class name provides discoverability and a stable namespace without unnecessary object
  lifecycle or inheritance.
- Named subordinate services retain that discoverability when one service grows beyond a readable
  size, while allowing implementations and tests to be split across files.
- Explicit session passing makes database access and test dependencies visible.
- Caller-owned transactions allow several service calls to succeed or fail atomically.
- Keeping HTTP types at the edge allows the same common rules to be used from non-HTTP contexts.
- Explicit transactions work with the project's `autobegin=False` configuration and make accidental
  queries outside a transaction fail early.

## Alternatives considered

- **Module-level service functions:** equally capable and idiomatic Python, but the team prefers the
  discoverability of `UserService.create_user()`.
- **A service instance for every feature:** unnecessary until a service has collaborators or state.
- **Unrelated top-level service classes after every split:** keeps implementation classes small but
  makes the feature's public entry points harder to discover. Named subordinate service attributes
  preserve a coherent public namespace.
- **Lexically nested implementation classes:** rejected because nested definitions are harder to
  import, test, type, and organise across modules than ordinary classes exposed through aliases.
- **Services create and commit their own sessions:** rejected because it hides boundaries and breaks
  atomic composition.
- **A Unit of Work abstraction:** useful if persistence backends or transaction participants multiply,
  but unnecessary over SQLAlchemy's existing session abstraction at the current scale.

## Consequences

- Database sessions appear explicitly in route, service, and task signatures.
- A service call never implies a commit; callers must establish a transaction before the first query.
- Tests may provide a transaction-bound session and roll it back after the test.
- Async API services cannot be called directly with the worker's synchronous session. Logic that must
  be shared across both runtimes should be extracted into pure domain functions or classes, while
  each runtime performs its own persistence operations.
- Static service classes must remain stateless. A new dependency is a signal to consider an instance
  service rather than a class variable or service locator.
- A primary service may expose stateless subordinate service classes as class attributes. These
  attributes are namespaces, not mutable singleton instances.
- A service should be split around cohesive responsibilities, not an arbitrary line count. Frequently
  coupled operations may remain together even when the implementation is substantial.

## Primary references

- [SQLAlchemy: session lifecycle and external transaction scope](https://docs.sqlalchemy.org/en/20/orm/session_basics.html#when-do-i-construct-a-session-when-do-i-commit-it-and-when-do-i-close-it)
- [SQLAlchemy: disabling implicit autobegin](https://docs.sqlalchemy.org/en/20/orm/session_basics.html#disabling-autobegin-to-prevent-implicit-transactions)
