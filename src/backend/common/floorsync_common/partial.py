"""Sentinel for partial updates.

A `PATCH` has to tell "leave this field alone" apart from "set this field to null", and `None`
already means the second. Every partial-update service takes `UNSET` as its default so an omitted
field and an explicitly cleared one stay distinguishable all the way down from the request body.
"""

from typing import Final


class Unset:
    """Marks a field the caller omitted, as distinct from one they explicitly set to null."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "UNSET"


UNSET: Final = Unset()

__all__ = ["UNSET", "Unset"]
