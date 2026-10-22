import type { ProblemDetail } from "@/core/http/contracts";
import type { GraphOperation } from "@/domains/scheduling/ui/JobGraphDiagram";
import type {
    ImportFormat,
    ImportIssueResponse,
    ImportJobPreviewResponse,
    ImportReportResponse,
} from "../data/api";

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

export interface ImportRoute {
    machine: string;
    duration: number;
    energy: string | null;
}

export interface ImportOperation {
    /** The operation's position in its job, as a string: the graph's node id. */
    id: string;
    name: string;
    routes: ImportRoute[];
    /** Ids of the operations it waits for. */
    dependsOn: string[];
}

export interface ImportJob {
    /** Position in the file. */
    index: number;
    name: string;
    priority: "high" | "med" | "low";
    location: string;
    operations: ImportOperation[];
    issues: ImportIssue[];
    warnings: ImportIssue[];
}

export interface ImportReport {
    format: ImportFormat | null;
    importable: boolean;
    summary: ImportSummary | null;
    /** Null when the file could not be read far enough to list its jobs. */
    jobs: ImportJob[] | null;
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

export const PRIORITY_LABELS: Record<ImportJob["priority"], string> = { high: "High", med: "Medium", low: "Low" };

function toImportJob(job: ImportJobPreviewResponse, index: number): ImportJob {
    return {
        index,
        name: job.name,
        priority: job.priority,
        location: job.location,
        operations: job.operations.map((operation, position) => ({
            id: String(position),
            name: operation.name,
            routes: operation.routes,
            dependsOn: operation.predecessors.map(String),
        })),
        issues: job.issues,
        warnings: job.warnings,
    };
}

/** Jobs whose name contains `query`, ignoring case. */
export function filterImportJobs(jobs: readonly ImportJob[], query: string): readonly ImportJob[] {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === "") return jobs;
    return jobs.filter((job) => job.name.toLocaleLowerCase().includes(needle));
}

/** A job's operations as the precedence graph draws them. */
export function graphOperations(job: ImportJob): GraphOperation[] {
    return job.operations.map((operation) => ({
        id: operation.id,
        name: operation.name,
        dependsOn: operation.dependsOn,
        durationMins: operation.routes[0]?.duration ?? null,
        machineCount: operation.routes.length,
    }));
}

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
        jobs: response.jobs?.map(toImportJob) ?? null,
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
