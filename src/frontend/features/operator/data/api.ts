import { apiRequest } from "@/core/http/client";
import type { ScheduleTimeline } from "@/domains/scheduling/contracts";

export interface ActiveSimulation {
    id: string;
    schedule_id: string;
    status: "not_started" | "running" | "paused" | "complete";
    speed: string;
    simulated_time: number;
    makespan: number;
    is_running: boolean;
    is_complete: boolean;
    derived_at: string;
}

/** The simulation operators follow. A 404 means nothing has been created yet. */
export function fetchActiveSimulation(token: string, signal?: AbortSignal) {
    return apiRequest<ActiveSimulation>("/api/v1/simulations/active", token, { signal });
}

export function fetchOperatorTimeline(scheduleId: string, token: string, signal?: AbortSignal) {
    return apiRequest<ScheduleTimeline>(
        `/api/v1/schedules/${encodeURIComponent(scheduleId)}/timeline`,
        token,
        { signal },
    );
}
