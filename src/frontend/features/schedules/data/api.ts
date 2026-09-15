import { apiRequest } from "@/core/http/client";
import type { ScheduleTimeline, TimelineLane, TimelineOperation } from "@/domains/scheduling/contracts";

export type { ScheduleTimeline, TimelineLane, TimelineOperation } from "@/domains/scheduling/contracts";

export interface ScheduleSummary {
    id: string; status: "draft" | "confirmed" | "discarded"; strategy: string; makespan: number | null;
    input_operation_count: number | null; created_at: string; confirmed_at: string | null;
}
export interface SchedulingIssue { code: string; message: string; operation_id?: string | null; machine_id?: string | null; }
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

export function requestSchedule(startsAt: string, token: string, strategy: ScheduleStrategy = "resched") {
    return apiRequest<ScheduleGenerationAccepted>("/api/v1/schedules", token, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ starts_at: startsAt, strategy }),
    });
}
export function fetchScheduleGeneration(generationId: string, token: string, signal?: AbortSignal) {
    return apiRequest<ScheduleGenerationStatus>(`/api/v1/schedules/generations/${encodeURIComponent(generationId)}`, token, { signal });
}
