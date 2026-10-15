import type { ProblemDetail } from "@/core/http/contracts";
import type { ImportFormat, ImportIssueResponse, ImportReportResponse } from "../data/api";

/** Benchmarks are JSON too, so one extension covers every format the API reads. */
export const ACCEPTED_FILE_TYPES = ["application/json", ".json"];
export const EXAMPLE_FILE_URL = "/import-example.json";
const IMPORT_INVALID = "urn:floorsync:problem:import-invalid";

export interface ImportIssue {
    code: string;
    message: string;
    location: string | null;
}

export interface ImportSummary {
    machinesCreated: string[];
    machinesReused: string[];
    categoriesCreated: string[];
    jobs: number;
    operations: number;
    routes: number;
    dependencies: number;
}

export interface ImportReport {
    format: ImportFormat | null;
    importable: boolean;
    summary: ImportSummary | null;
    jobIds: string[];
    issues: ImportIssue[];
    warnings: ImportIssue[];
}

/** What the Preview panel shows, for the file in the Upload panel or the import just made. */
export type PreviewState =
    | { kind: "empty" }
    | { kind: "checking"; fileName: string }
    | { kind: "checked"; fileName: string; report: ImportReport }
    /** The import was refused: the API's issues, read from its 422. */
    | { kind: "rejected"; fileName: string; detail: string; issues: ImportIssue[]; warnings: ImportIssue[] }
    /** No report came back at all, such as a network failure. */
    | { kind: "failed"; fileName: string; message: string }
    | { kind: "imported"; fileName: string; report: ImportReport };

export const FORMAT_LABELS: Record<ImportFormat, string> = {
    floorsync: "FloorSync file",
    jobshop: "Job-shop benchmark",
    "flexible-jobshop": "Flexible job-shop benchmark",
};

export function toImportReport(response: ImportReportResponse): ImportReport {
    const { summary } = response;
    return {
        format: response.format,
        importable: response.importable,
        summary:
            summary === null
                ? null
                : {
                    machinesCreated: summary.machines_created,
                    machinesReused: summary.machines_reused,
                    categoriesCreated: summary.categories_created,
                    jobs: summary.jobs,
                    operations: summary.operations,
                    routes: summary.routes,
                    dependencies: summary.dependencies,
                },
        jobIds: response.job_ids,
        issues: response.issues,
        warnings: response.warnings,
    };
}

/**
 * The issues and warnings an `import-invalid` problem carries, or null for
 * any other failure, which has no file issues to show.
 */
export function rejectedIssues(
    problem: ProblemDetail | null,
): { detail: string; issues: ImportIssue[]; warnings: ImportIssue[] } | null {
    if (problem?.type !== IMPORT_INVALID) return null;
    return {
        detail: problem.detail ?? problem.title,
        issues: issueList(problem.extensions.issues),
        warnings: issueList(problem.extensions.warnings),
    };
}

function issueList(value: unknown): ImportIssue[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): ImportIssue[] => {
        if (entry === null || typeof entry !== "object") return [];
        const { code, message, location } = entry as Partial<ImportIssueResponse>;
        if (typeof code !== "string" || typeof message !== "string") return [];
        return [{ code, message, location: typeof location === "string" ? location : null }];
    });
}

export function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}
