import { apiRequest } from "@/core/http/client";
import type { ScheduleTimeline, TimelineLane, TimelineOperation } from "@/domains/scheduling/contracts";

export type { ScheduleTimeline, TimelineLane, TimelineOperation } from "@/domains/scheduling/contracts";

export interface ScheduleSummary {
    id: string; status: "draft" | "confirmed" | "discarded"; strategy: string; makespan: number | null;
    input_operation_count: number | null; created_at: string; confirmed_at: string | null;
    confirmed_by_user_id: string | null;
}
export interface SchedulingIssue {
    code: string;
    message: string;
    job_id?: string | null;
    operation_id?: string | null;
    machine_id?: string | null;
    schedule_id?: string | null;
}
export interface ScheduleValidation {
    schedulable: Record<ScheduleStrategy, boolean>;
    issues: SchedulingIssue[];
    warnings: SchedulingIssue[];
    unsupported: { strategy: ScheduleStrategy; issue: SchedulingIssue }[];
}
export interface ScheduleGenerationAccepted { id: string; status: "pending"; status_url: string; }
export type ScheduleGenerationStatus =
    | { id: string; status: "pending" | "running" }
    | { id: string; status: "completed"; schedule_id: string; schedule_url: string }
    | { id: string; status: "rejected"; issues: SchedulingIssue[] }
    | { id: string; status: "unavailable" | "failed"; detail: string };

export function fetchSchedules(token: string, signal?: AbortSignal) {
    return apiRequest<ScheduleSummary[]>("/api/v1/schedules", token, { signal });
}
export function fetchScheduleTimeline(scheduleId: string, token: string, signal?: AbortSignal) {
    return apiRequest<ScheduleTimeline>(`/api/v1/schedules/${encodeURIComponent(scheduleId)}/timeline`, token, { signal });
}
/** Which engine plans the floor: the learned ReSched policy, or the exact Gurobi solver. */
export type ScheduleStrategy = "resched" | "exact";

export function requestSchedule(
    startsAt: string,
    jobIds: string[],
    token: string,
    strategy: ScheduleStrategy = "resched",
) {
    return apiRequest<ScheduleGenerationAccepted>("/api/v1/schedules", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starts_at: startsAt, job_ids: jobIds, strategy }),
    });
}
export function validateSchedule(jobIds: string[], token: string, signal?: AbortSignal) {
    const query = new URLSearchParams();
    jobIds.forEach((jobId) => query.append("job_ids", jobId));
    return apiRequest<ScheduleValidation>(`/api/v1/schedules/validation?${query.toString()}`, token, { signal });
}
export function updateScheduleStatus(
    scheduleId: string,
    status: "confirmed" | "discarded",
    token: string,
) {
    return apiRequest<ScheduleSummary>(
        `/api/v1/schedules/${encodeURIComponent(scheduleId)}`,
        token,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status }),
        },
    );
}
export function deleteSchedule(scheduleId: string, token: string): Promise<void> {
    return apiRequest<void>(`/api/v1/schedules/${encodeURIComponent(scheduleId)}`, token, { method: "DELETE" });
}
export function fetchScheduleGeneration(generationId: string, token: string, signal?: AbortSignal) {
    return apiRequest<ScheduleGenerationStatus>(`/api/v1/schedules/generations/${encodeURIComponent(generationId)}`, token, { signal });
}
