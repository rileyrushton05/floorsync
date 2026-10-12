"""Expected outcomes of reading and importing a file.

Concrete frozen variants, handled exhaustively at the web edge (docs/backend-conventions.md). A
file with problems is an expected outcome, not an error: the preview exists to report exactly that.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from floorsync_common.imports.plan import ImportFormat, ImportIssue, ImportPlan
from floorsync_common.outcomes import ExpectedOutcome


@dataclass(frozen=True, slots=True)
class PlanRead:
    """The file was understood; `plan` is what it asks to add, not yet checked."""

    plan: ImportPlan


@dataclass(frozen=True, slots=True)
class FileUnreadable(ExpectedOutcome):
    """The file could not be turned into a plan: not JSON, an unknown format, or malformed.

    Every structural problem found is listed, not only the first, so one round trip shows a
    person everything they have to fix in the file's shape.
    """

    issues: tuple[ImportIssue, ...]


type ReadFileResult = PlanRead | FileUnreadable


@dataclass(frozen=True, slots=True)
class ImportSummary:
    """What a plan adds to the floor, as counts and the machine names it creates or reuses."""

    format: ImportFormat
    machines_created: tuple[str, ...]
    machines_reused: tuple[str, ...]
    categories_created: tuple[str, ...]
    jobs: int
    operations: int
    routes: int
    dependencies: int


@dataclass(frozen=True, slots=True)
class ImportApplied:
    """Every row the plan describes has been written, in the caller's transaction.

    `job_ids` are the new jobs in the order the file listed them.
    """

    summary: ImportSummary
    job_ids: tuple[UUID, ...]
    warnings: tuple[ImportIssue, ...]


@dataclass(frozen=True, slots=True)
class ImportRejected(ExpectedOutcome):
    """The plan has problems, so it must not be kept.

    The caller rolls its transaction back: the problems are almost always found before anything is
    written, but one (a machine deactivated by someone else mid-import) can only be seen after the
    machines have been inserted.
    """

    summary: ImportSummary
    issues: tuple[ImportIssue, ...]
    warnings: tuple[ImportIssue, ...]


type ImportPlanResult = ImportApplied | ImportRejected
