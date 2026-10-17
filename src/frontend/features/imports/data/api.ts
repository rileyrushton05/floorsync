import { apiRequest } from "@/core/http/client";

export type ImportFormat = "floorsync" | "jobshop" | "flexible-jobshop";

/** One problem with a file, or a warning about it. `code` is listed in docs/importing.md. */
export interface ImportIssueResponse {
    code: string;
    message: string;
    /** Where in the file, such as `jobs[2].operations[0].routes[1].duration`; null for the whole file. */
    location: string | null;
}

export interface ImportSummaryResponse {
    machines_created: string[];
    machines_reused: string[];
    categories_created: string[];
    jobs: number;
    operations: number;
    routes: number;
    dependencies: number;
}

export interface ImportRoutePreviewResponse {
    machine: string;
    duration: number;
    /** Decimal as a string, or null when the file gives none. */
    energy: string | null;
}

export interface ImportOperationPreviewResponse {
    name: string;
    routes: ImportRoutePreviewResponse[];
    /** Positions in the job's `operations` this one waits for, with list-order chaining applied. */
    predecessors: number[];
}

export interface ImportJobPreviewResponse {
    name: string;
    priority: "high" | "med" | "low";
    /** Where the job is in the file, such as `jobs[2]`. */
    location: string;
    operations: ImportOperationPreviewResponse[];
    /** The report's issues and warnings that point into this job. */
    issues: ImportIssueResponse[];
    warnings: ImportIssueResponse[];
}

/** What an import did or, for a dry run, would do. A real import with issues is a 422 instead. */
export interface ImportReportResponse {
    format: ImportFormat | null;
    dry_run: boolean;
    importable: boolean;
    /** Null when the file could not be read at all. */
    summary: ImportSummaryResponse | null;
    /** Every job the file describes, in its order; null when the file could not be read at all. */
    jobs: ImportJobPreviewResponse[] | null;
    /** The new jobs in the file's order; empty for a dry run. */
    job_ids: string[];
    issues: ImportIssueResponse[];
    warnings: ImportIssueResponse[];
}

/**
 * Upload a FloorSync file or ScheduleOpt benchmark. A dry run reports what the
 * import would add without keeping any of it.
 */
export function importFile(file: File, dryRun: boolean, token: string): Promise<ImportReportResponse> {
    const body = new FormData();
    body.append("file", file);
    const query = dryRun ? "?dry_run=true" : "";
    // No Content-Type: the browser sets the multipart boundary itself.
    return apiRequest<ImportReportResponse>(`/api/v1/imports${query}`, token, { method: "POST", body });
}
