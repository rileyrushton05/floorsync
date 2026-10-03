import { ApiError, apiRequest } from "@/core/http/client";
import type { CursorPage } from "@/core/http/contracts";
import type { BacklogStatus } from "@/domains/scheduling/types";

export type { CursorPage } from "@/core/http/contracts";

export interface Job {
    id: string;
    name: string;
    /** When the job left the backlog, or null while it is still open. */
    archived_at: string | null;
    backlog_status: BacklogStatus;
    planned_by_schedule_ids: string[];
    created_at: string;
    updated_at: string;
}

export type JobPriority = "high" | "med" | "low";

export interface JobDefinitionRoute {
    machine_id: string;
    duration_minutes: number;
    energy: string | null;
}

export interface JobDefinitionOperation {
    id: string;
    position: number;
    name: string;
    routes: JobDefinitionRoute[];
}

export interface JobDefinition {
    id: string;
    name: string;
    priority: JobPriority;
    /** When the job left the backlog, or null while it is still open. */
    archived_at: string | null;
    backlog_status: BacklogStatus;
    planned_by_schedule_ids: string[];
    created_at: string;
    updated_at: string;
    operations: JobDefinitionOperation[];
}

export interface JobDefinitionRouteInput {
    machine_id: string;
    duration_minutes: number;
    energy?: string | null;
}

export interface JobDefinitionOperationInput {
    id?: string;
    name: string;
    routes: JobDefinitionRouteInput[];
}

export interface JobDefinitionInput {
    name: string;
    priority: JobPriority;
    operations: JobDefinitionOperationInput[];
}

export function fetchJobs(token: string, limit = 100, cursor?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return apiRequest<CursorPage<Job>>(`/api/v1/jobs?${query.toString()}`, token, { signal });
}

export function deleteJob(jobId: string, token: string): Promise<void> {
    return apiRequest<void>(`/api/v1/jobs/${encodeURIComponent(jobId)}`, token, { method: "DELETE" });
}

/**
 * Retire a job from the backlog by hand.
 *
 * One way on purpose (decision 0018): the API takes `archived: true` and has no
 * `false`, because the job a manager most wants back — one a plan claimed — was
 * never archived in the first place. That one comes back by discarding the
 * plan, and an archived job comes back as a duplicate.
 */
export function archiveJob(jobId: string, token: string): Promise<Job> {
    return apiRequest<Job>(`/api/v1/jobs/${encodeURIComponent(jobId)}`, token, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
    });
}

/** The schedules standing in the way of deleting a job, as the refusal names them. */
export interface ScheduleReferences {
    /** Drafts, which can be deleted to clear the way. */
    draftScheduleIds: string[];
    /** Confirmed schedules, which are a record of what the floor was told to do. */
    confirmedScheduleIds: string[];
}

function scheduleIds(extensions: Record<string, unknown>, member: string): string[] {
    const value = extensions[member];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Read a delete refusal's own account of what is in the way.
 *
 * `DELETE /api/v1/jobs/{id}` answers 409 `job-is-scheduled` with the two lists
 * as problem extension members, because what the manager can do next depends on
 * which kind is in the way: a draft is a proposal the page can delete for them,
 * a confirmed schedule is history and leaves archiving as the way out. Returns
 * null for anything else, including a refusal that names neither.
 */
export function scheduleReferences(error: unknown): ScheduleReferences | null {
    if (!(error instanceof ApiError)) return null;
    if (error.problem?.type !== "urn:floorsync:problem:job-is-scheduled") return null;
    const references = {
        draftScheduleIds: scheduleIds(error.problem.extensions, "draft_schedule_ids"),
        confirmedScheduleIds: scheduleIds(error.problem.extensions, "confirmed_schedule_ids"),
    };
    return references.draftScheduleIds.length + references.confirmedScheduleIds.length > 0
        ? references
        : null;
}


/** One precedence edge: `before` must finish before `after` starts. */
export interface DependencyEdge {
    before_operation_id: string;
    after_operation_id: string;
}

export interface JobDependencies {
    edges: DependencyEdge[];
}

/**
 * A job's precedence graph: every edge whose `after` operation belongs to it.
 *
 * Separate from the job definition on purpose — the definition endpoint can
 * only express a straight chain through operation order, while this carries
 * arbitrary edges.
 */
export function fetchJobDependencies(jobId: string, token: string, signal?: AbortSignal) {
    return apiRequest<JobDependencies>(
        `/api/v1/jobs/${encodeURIComponent(jobId)}/dependencies`,
        token,
        { signal },
    );
}

/**
 * Replace a job's precedence graph wholesale.
 *
 * The API deletes every edge pointing into this job's operations and writes
 * these in their place, so this must be sent *after* a definition save: that
 * save re-derives a straight chain from operation order, and this is what
 * replaces it with the real graph.
 */
export function replaceJobDependencies(
    jobId: string,
    edges: DependencyEdge[],
    token: string,
): Promise<JobDependencies> {
    return apiRequest<JobDependencies>(
        `/api/v1/jobs/${encodeURIComponent(jobId)}/dependencies`,
        token,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ edges }),
        },
    );
}

/**
 * Page through job definitions.
 *
 * `includeArchived` is what the builder uses: the API hides archived jobs by
 * default, which is right for the schedulable backlog but wrong for a screen
 * whose job is to show a manager what a finished job contained and offer them a
 * copy of it. The archived/active split is then a filter on this screen rather
 * than a second fetch.
 */
export function fetchJobDefinitions(
    token: string,
    limit = 100,
    cursor?: string,
    signal?: AbortSignal,
    includeArchived = false,
) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    if (includeArchived) query.set("include_archived", "true");
    return apiRequest<CursorPage<JobDefinition>>(`/api/v1/job-definitions?${query.toString()}`, token, { signal });
}

export function createJobDefinition(definition: JobDefinitionInput, token: string): Promise<JobDefinition> {
    return apiRequest<JobDefinition>("/api/v1/job-definitions", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(definition),
    });
}

export function replaceJobDefinition(jobId: string, definition: JobDefinitionInput, token: string): Promise<JobDefinition> {
    return apiRequest<JobDefinition>(`/api/v1/jobs/${encodeURIComponent(jobId)}/definition`, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(definition),
    });
}
