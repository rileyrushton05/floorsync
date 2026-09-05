"""Typed marker for expected application outcomes."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ExpectedOutcome:
    """Identify an explicitly returned outcome without defining generic handling."""


__all__ = ["ExpectedOutcome"]
