import type { ScheduleSummary } from "../data/api";
import { formatDuration } from "@/domains/scheduling/format";
import { formatCreatedAt, scheduleDisplayName, strategyLabel } from "./archive";

export interface ScheduleOption {
    id: string;
    status: "confirmed" | "draft" | "discarded";
    label: string;
}

/** Converts a transport schedule into the compact contract the picker needs. */
export function toScheduleOption(schedule: ScheduleSummary): ScheduleOption {
    const makespan = schedule.makespan === null ? "no makespan" : formatDuration(schedule.makespan);
    return {
        id: schedule.id,
        status: schedule.status,
        label: `${scheduleDisplayName(schedule)} · ${strategyLabel(schedule.strategy)} · ${makespan} · ${formatCreatedAt(schedule.created_at)}`,
    };
}
