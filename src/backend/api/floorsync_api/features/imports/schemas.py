from typing import Literal
from uuid import UUID

from floorsync_api.schemas import ResponseSchema

type ImportFormatValue = Literal["floorsync", "jobshop", "flexible-jobshop"]


class ImportIssueResponse(ResponseSchema):
    """One problem with a file, or a warning about it.

    `code` is stable and listed in docs/importing.md. `location` points into the file, such as
    `jobs[2].operations[0].routes[1].duration`, or is null for the file as a whole.
    """

    code: str
    message: str
    location: str | None


class ImportSummaryResponse(ResponseSchema):
    """What the file adds to the floor: counts, and the machines it creates or reuses by name."""

    machines_created: list[str]
    machines_reused: list[str]
    categories_created: list[str]
    jobs: int
    operations: int
    routes: int
    dependencies: int


class ImportReportResponse(ResponseSchema):
    """What an import did or, for a dry run, would do.

    `importable` is false when `issues` is not empty; a real import with issues is refused with a
    422 instead. `summary` is null when the file could not be read at all. `job_ids` lists the new
    jobs in the file's order, and is empty for a dry run, which keeps nothing.
    """

    format: ImportFormatValue | None
    dry_run: bool
    importable: bool
    summary: ImportSummaryResponse | None
    job_ids: list[UUID]
    issues: list[ImportIssueResponse]
    warnings: list[ImportIssueResponse]
