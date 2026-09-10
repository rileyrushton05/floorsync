"""Sentinel for partial updates.

A `PATCH` has to tell "leave this field alone" apart from "set this field to null", and `None`
already means the second. Every partial-update service takes `UNSET` as its default so an omitted
field and an explicitly cleared one stay distinguishable all the way down from the request body.
"""

from typing import Final, TypeGuard


class Unset:
    """Marks a field the caller omitted, as distinct from one they explicitly set to null."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "UNSET"


UNSET: Final = Unset()


def is_set[T](value: T | Unset) -> TypeGuard[T]:
    """Report whether the caller supplied this field, narrowing it to its real type if so.

    A `TypeGuard` rather than a function that assigns for you: two of the fields this guards are not
    plain assignments -- they validate first and return a different outcome when the value is
    rejected -- and a helper cannot return on its caller's behalf. Narrowing instead keeps one idiom
    across every field, including those, and avoids naming attributes as strings.
    """

    return not isinstance(value, Unset)


__all__ = ["UNSET", "Unset", "is_set"]
