"""Read an uploaded file and write it into the floor's own tables, all of it or none of it
(decision 0020).

Pasindu's brief: another company's data is imported into our setup tables, not kept apart. So a
plan becomes ordinary rows in `jobs`, `operations`, `compatibilities` and `dependencies`, the same
rows the job builder writes, and every imported job is a new open job in the backlog.

Machines and categories are the exception, because a file and the floor can share them: they are
matched by exact name, reused when the floor has them, and never modified by an import. The floor's
values win; a file that disagrees gets a warning, not an overwrite.

`ImportService` runs the steps in order; each capability is its own service, reachable as
`ImportService.Parsing`, `ImportService.Validation` and `ImportService.Persistence`.

The caller owns the transaction (docs/backend-conventions.md) and must roll it back unless the
result is `ImportApplied`, and for a dry run.
"""

from __future__ import annotations

from dataclasses import replace

from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.imports.parsing import ImportParsingService
from floorsync_common.imports.persistence import ImportPersistenceService
from floorsync_common.imports.plan import ImportPlan, PlannedMachine
from floorsync_common.imports.results import (
    ImportApplied,
    ImportPlanResult,
    ImportRejected,
    ImportSummary,
)
from floorsync_common.imports.validation import ImportValidationService


class ImportService:
    """Import a file: `Parsing.read_file` before the transaction, then `import_plan` inside it."""

    Parsing = ImportParsingService
    Validation = ImportValidationService
    Persistence = ImportPersistenceService

    @staticmethod
    async def import_plan(db: AsyncSession, plan: ImportPlan) -> ImportPlanResult:
        """Check `plan` against itself and the floor, then write every row it describes.

        Every problem is collected before anything is written, so a rejection lists them all.
        Machines a route names must be declared in the file or already on the floor, and active.
        """

        issues = list(ImportService.Validation.check_plan(plan))
        file_warnings = ImportService.Validation.plan_warnings(plan)

        # The first declaration of a name wins; a repeat is already a `duplicate_machine` issue.
        declared: dict[str, PlannedMachine] = {}
        for machine in plan.machines:
            declared.setdefault(machine.name, machine)
        routes = [
            route for job in plan.jobs for operation in job.operations for route in operation.routes
        ]
        needed = list(dict.fromkeys([*declared, *(route.machine for route in routes)]))

        floor = await ImportService.Persistence.load_machines(db, needed)
        issues.extend(ImportService.Validation.route_machine_issues(routes, declared, floor))

        to_create = [machine for name, machine in declared.items() if name not in floor]
        similar = await ImportService.Persistence.similar_names(db, to_create)
        categories = list(
            dict.fromkeys(machine.category for machine in to_create if machine.category)
        )
        known_categories = await ImportService.Persistence.load_category_ids(db, categories)

        summary = ImportSummary(
            format=plan.format,
            machines_created=tuple(machine.name for machine in to_create),
            machines_reused=tuple(name for name in needed if name in floor),
            categories_created=tuple(name for name in categories if name not in known_categories),
            jobs=len(plan.jobs),
            operations=plan.operation_count,
            routes=plan.route_count,
            dependencies=sum(
                len(ImportService.Validation.precedence_edges(job)) for job in plan.jobs
            ),
        )
        if issues:
            warnings = (
                *file_warnings,
                *ImportService.Validation.floor_differences(declared, floor),
                *similar,
            )
            return ImportRejected(summary=summary, issues=tuple(issues), warnings=warnings)

        (
            machines,
            created_machines,
            created_categories,
        ) = await ImportService.Persistence.create_missing_machines(db, to_create, needed)
        # What this import actually inserted. Normally what was planned, but a machine another
        # import created a moment earlier was waited for and reused, so it is reported as reused.
        summary = replace(
            summary,
            machines_created=tuple(name for name in needed if name in created_machines),
            machines_reused=tuple(name for name in needed if name not in created_machines),
            categories_created=tuple(name for name in categories if name in created_categories),
        )
        # Judged against the machines as they are now: one another import created after the first
        # lookup is reused with its values, not the file's, and the file must be told.
        warnings = (
            *file_warnings,
            *ImportService.Validation.floor_differences(declared, machines),
            *similar,
        )

        # Seen only now, with the machines locked: one someone else created inactive, which this
        # import then reused instead of creating, or one deleted since the first lookup. Every
        # machine must be on the floor by now, so the file declaring one no longer counts.
        late = ImportService.Validation.route_machine_issues(routes, {}, machines)
        if late:
            return ImportRejected(summary=summary, issues=tuple(late), warnings=warnings)

        job_ids = await ImportService.Persistence.insert_jobs(
            db, plan, {name: machine.id for name, machine in machines.items()}
        )
        return ImportApplied(summary=summary, job_ids=job_ids, warnings=warnings)
