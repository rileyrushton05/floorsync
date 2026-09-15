import { apiRequest } from "@/core/http/client";
import type { CursorPage } from "@/core/http/contracts";

export type { CursorPage } from "@/core/http/contracts";

export interface Job {
    id: string;
    name: string;
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

export function fetchJobDefinitions(token: string, limit = 100, cursor?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
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
