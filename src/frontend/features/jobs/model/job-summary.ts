import type { Job } from "../data/api";
import type { BacklogStatus } from "@/domains/scheduling/types";

/** Lightweight frontend model for backlog consumers that do not edit routes. */
export interface JobSummary {
    id: string;
    name: string;
    archivedAt: string | null;
    backlogStatus: BacklogStatus;
    plannedByScheduleIds: string[];
    createdAt: string;
}

/** Keep API casing at the data/model boundary rather than leaking it into screens. */
export function toJobSummary(job: Job): JobSummary {
    return {
        id: job.id,
        name: job.name,
        archivedAt: job.archived_at,
        backlogStatus: job.backlog_status,
        plannedByScheduleIds: job.planned_by_schedule_ids,
        createdAt: job.created_at,
    };
}
