import type { ScheduleSummary } from "../data/api";
import { formatDuration } from "@/domains/scheduling/format";

export interface ScheduleOption {
    id: string;
    status: "confirmed" | "draft" | "discarded";
    label: string;
}

function formatCreated(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    return at.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/** Converts a transport schedule into the compact contract the picker needs. */
export function toScheduleOption(schedule: ScheduleSummary): ScheduleOption {
    const makespan = schedule.makespan === null ? "no makespan" : formatDuration(schedule.makespan);
    return {
        id: schedule.id,
        status: schedule.status,
        label: `${schedule.strategy} · ${makespan} · ${formatCreated(schedule.created_at)}`,
    };
}
