"""Read a ScheduleOpt benchmark instance into an import plan.

The seed loader's parsers are reused unchanged, so a benchmark imports the same way it seeds. They
stop at the first problem, which is fine for files that come from an upstream benchmark set rather
than from a person. Machine names match the seed loader's (`abz5/M3`), so importing an instance the
database was seeded with reuses its machines; jobs carry the instance name too (`abz5/J7`), since a
floor can hold jobs from several imports. Labels are zero-padded so they sort correctly as text.

Nothing here touches the database.
"""

from __future__ import annotations

from collections.abc import Mapping

from floorsync_common.imports.checks import check_size
from floorsync_common.imports.plan import (
    ImportFormat,
    ImportIssue,
    ImportIssueCode,
    ImportPlan,
    PlannedJob,
    PlannedMachine,
    PlannedOperation,
    PlannedRoute,
)
from floorsync_common.imports.results import FileUnreadable, PlanRead, ReadFileResult
from floorsync_common.seed.flexible import parse_flexible_instance
from floorsync_common.seed.instances import InstanceError, parse_instance


def read_jobshop(document: Mapping[str, object]) -> ReadFileResult:
    """A classic instance: every job a straight chain, every operation on exactly one machine.

    A declared job with no operations is left out: there is nothing to schedule in it.
    """

    try:
        instance = parse_instance(document)
    except InstanceError as error:
        issue = ImportIssue(
            ImportIssueCode.INVALID_BENCHMARK,
            f"The file is not a valid job-shop instance: {error}.",
        )
        return FileUnreadable(issues=(issue,))

    # Checked before anything is built: the declared counts, unlike `data`, cost nothing to write.
    issues = check_size(
        machines=instance.machine_count,
        jobs=instance.job_count,
        rows=instance.machine_count + instance.job_count + 2 * len(instance.operations),
        machines_at="machines",
        jobs_at="jobs",
    )
    if issues:
        return FileUnreadable(issues=issues)

    machine_width = len(str(instance.machine_count - 1))
    machine_names = [
        f"{instance.name}/M{index:0{machine_width}d}" for index in range(instance.machine_count)
    ]
    job_width = len(str(instance.job_count - 1))

    jobs: list[PlannedJob] = []
    for job, operations in instance.operations_by_job.items():
        if not operations:
            continue
        operation_width = len(str(len(operations) - 1))
        planned_operations = tuple(
            PlannedOperation(
                name=f"Op{operation.index:0{operation_width}d}",
                routes=(
                    PlannedRoute(
                        machine=machine_names[operation.machine],
                        duration=operation.duration,
                        energy=None,
                        location=f"data (job {job}, operation {operation.index})",
                    ),
                ),
                # The file's only precedence is operation order, which is list order here.
                after=None,
                location=f"data (job {job}, operation {operation.index})",
            )
            for operation in operations
        )
        jobs.append(
            PlannedJob(
                name=f"{instance.name}/J{job:0{job_width}d}",
                priority="med",
                operations=planned_operations,
                location=f"data (job {job})",
            )
        )

    return PlanRead(
        plan=ImportPlan(
            format=ImportFormat.JOBSHOP,
            machines=tuple(
                PlannedMachine(name=name, category=None, salary=None, location="machines")
                for name in machine_names
            ),
            jobs=tuple(jobs),
        )
    )


def read_flexible_jobshop(document: Mapping[str, object]) -> ReadFileResult:
    """A flexible instance: several candidate machines per operation, explicit precedence edges.

    Every operation's predecessors are stated, even when there are none, because this format's
    edges are the precedence: a job can branch, so list order means nothing. Operations are listed
    by id, and every committed instance numbers an operation after those it waits on.
    """

    try:
        instance = parse_flexible_instance(document)
    except InstanceError as error:
        issue = ImportIssue(
            ImportIssueCode.INVALID_BENCHMARK,
            f"The file is not a valid flexible job-shop instance: {error}.",
        )
        return FileUnreadable(issues=(issue,))

    machine_width = len(str(max(instance.machine_labels, default=0)))
    machine_names = {
        label: f"{instance.name}/M{label:0{machine_width}d}" for label in instance.machine_labels
    }
    job_width = len(str(max(instance.job_labels, default=0)))
    operation_width = len(str(max((operation.id for operation in instance.operations), default=0)))
    operation_names = {
        operation.id: f"Op{operation.id:0{operation_width}d}" for operation in instance.operations
    }

    predecessors: dict[int, list[str]] = {}
    for before, after in instance.dependencies:
        predecessors.setdefault(after, []).append(operation_names[before])

    jobs: list[PlannedJob] = []
    for job, operations in instance.operations_by_job.items():
        planned_operations = tuple(
            PlannedOperation(
                name=operation_names[operation.id],
                routes=tuple(
                    PlannedRoute(
                        machine=machine_names[candidate.machine],
                        duration=candidate.duration,
                        energy=None,
                        location=(
                            f"operations (operation {operation.id}, machine {candidate.machine})"
                        ),
                    )
                    for candidate in operation.candidates
                ),
                after=tuple(predecessors.get(operation.id, ())),
                location=f"operations (operation {operation.id})",
            )
            for operation in operations
        )
        jobs.append(
            PlannedJob(
                name=f"{instance.name}/J{job:0{job_width}d}",
                priority="med",
                operations=planned_operations,
                location=f"precedences (job {job})",
            )
        )

    return PlanRead(
        plan=ImportPlan(
            format=ImportFormat.FLEXIBLE_JOBSHOP,
            machines=tuple(
                PlannedMachine(name=name, category=None, salary=None, location="operations")
                for name in machine_names.values()
            ),
            jobs=tuple(jobs),
        )
    )
