# Decision: Typed expected outcomes with exhaustive handling

## Date

2026-09-02

## Status

Accepted

## Context

Application operations have expected outcomes that are not successful values but are also not
unexpected technical failures. Examples include not-found, validation refusal, rule violation,
already-completed, and no-op. Raising these outcomes hides them from the return annotation, while
returning `None`, booleans, strings, or untyped sentinel objects loses context and makes omissions at
call sites difficult to detect.

Cross-cutting observability and HTTP adapter code also needs to identify values that represent
expected outcomes without encouraging business code to collapse them into one generic error case.

## Decision

1. Represent each expected application outcome as a concrete, frozen, slotted dataclass.
2. Concrete outcome classes inherit from an empty `ExpectedOutcome` marker. The marker carries no
   fields and no behaviour and exists only for identification by cross-cutting infrastructure.
3. Each operation declares a closed union of its concrete success and expected-outcome variants.
   Return annotations must never use `ExpectedOutcome` as a catch-all member.
4. Callers narrow on concrete variants and finish exhaustive `match` statements with
   `typing.assert_never()`.
5. Business code must not use `isinstance(result, ExpectedOutcome)` or `case ExpectedOutcome()` as a
   handling branch.
6. Expected domain outcomes are returned rather than raised. Unexpected infrastructure failures,
   programming errors, cancellation, and broken internal invariants continue to raise exceptions.
7. An expected outcome is not inherently an error. HTTP status, log severity, retry behaviour, and
   metrics are decisions made for each concrete outcome at the relevant boundary.

```python
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ExpectedOutcome:
    """Marker base for explicitly returned application outcomes."""
```

```python
@dataclass(frozen=True, slots=True)
class UserCreated:
    user: User


@dataclass(frozen=True, slots=True)
class EmailAlreadyExists(ExpectedOutcome):
    email: str


type CreateUserResult = UserCreated | EmailAlreadyExists
```

```python
match result:
    case UserCreated(user=user):
        return UserRead.model_validate(user)
    case EmailAlreadyExists(email=email):
        return conflict_problem(email)
    case _:
        assert_never(result)
```

## Rationale

- A concrete union documents every expected result in the service signature.
- Frozen dataclasses carry typed context and cannot be accidentally mutated after creation.
- `assert_never()` makes adding a new union member fail static checking at consumers that have not
  handled it.
- The marker gives observability and web registries a safe registration type while preserving
  concrete handling.
- Separating expected outcomes from exceptions prevents routine refusals from being reported as
  crashes without attempting to encode every possible technical failure in return types.

## Alternatives considered

- **Raise domain exceptions:** concise, but expected outcomes are absent from return annotations and
  exhaustive handling cannot be checked by mypy.
- **Bare singleton sentinels:** useful for a single context-free state, but cannot carry identifiers or
  validation details and are less descriptive in unions.
- **One generic `Result[T, E]` wrapper:** possible, but adds wrapping and generic machinery without
  improving the concrete union or Python pattern matching.
- **Return `None`, `bool`, or an error string:** rejected because these values lose domain meaning and
  context.
- **Handle the marker base generically:** rejected because it converts a typed union into an untyped
  error channel and incorrectly assumes all expected outcomes share severity or transport semantics.

## Consequences

- Public service methods have explicit return annotations and avoid `Any` in their return paths.
- Adding a new expected outcome is intentionally a breaking static-contract change for exhaustive
  consumers.
- Success may be a domain value directly or a named success variant. Use a named success variant when
  it improves symmetry or carries operation-specific metadata.
- HTTP adapters map concrete outcomes to RFC 9457 problem responses or successful no-op responses.
- Observability configuration may select concrete `ExpectedOutcome` subclasses, but there is no
  fallback rule that logs or maps every expected outcome as an error.
- Strict mypy checking is the primary enforcement mechanism. A custom lint rule will be considered
  only if violations occur that normal return checking and `assert_never()` do not catch.

## Primary references

- [Python typing: `Never` and `assert_never`](https://docs.python.org/3/library/typing.html#typing.Never)
- [Mypy: exhaustive checking](https://mypy.readthedocs.io/en/stable/literal_types.html#exhaustiveness-checking)
