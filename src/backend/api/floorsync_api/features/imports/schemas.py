from decimal import Decimal
from uuid import UUID

from floorsync_api.schemas import ResponseSchema
from floorsync_common.database.models.job import JobPriority
from floorsync_common.imports.plan import ImportFormat, ImportIssueCode


class ImportIssueResponse(ResponseSchema):
    """One problem with a file, or a warning about it.

    `code` is stable and listed in docs/importing.md. `location` points into the file, such as
    `jobs[2].operations[0].routes[1].duration`, or is null for the file as a whole.
    """

    code: ImportIssueCode
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


class ImportRoutePreviewResponse(ResponseSchema):
    """One machine an operation can run on, by name as the file gives it."""

    machine: str
    duration: int
    energy: Decimal | None


class ImportOperationPreviewResponse(ResponseSchema):
    """One step of a job in the file.

    `predecessors` are the positions, in the job's `operations`, of the steps this one waits for:
    the chain in list order when the job states no `after`, otherwise only what it states.
    """

    name: str
    routes: list[ImportRoutePreviewResponse]
    predecessors: list[int]


class ImportJobPreviewResponse(ResponseSchema):
    """One job the file describes, as it would be added. `location` is where it is in the file.

    `issues` and `warnings` are the report's own that point into this job: at the job, one of its
    operations or one of their routes.
    """

    name: str
    priority: JobPriority
    location: str
    operations: list[ImportOperationPreviewResponse]
    issues: list[ImportIssueResponse]
    warnings: list[ImportIssueResponse]


class ImportReportResponse(ResponseSchema):
    """What an import did or, for a dry run, would do.

    `importable` is false when `issues` is not empty; a real import with issues is refused with a
    422 instead. `summary` and `jobs` are null when the file could not be read at all. `jobs` is
    every job the file describes, in its order, so a dry run can be previewed job by job. `job_ids`
    lists the new jobs in the file's order, and is empty for a dry run, which keeps nothing.
    """

    format: ImportFormat | None
    dry_run: bool
    importable: bool
    summary: ImportSummaryResponse | None
    jobs: list[ImportJobPreviewResponse] | None
    job_ids: list[UUID]
    issues: list[ImportIssueResponse]
    warnings: list[ImportIssueResponse]
