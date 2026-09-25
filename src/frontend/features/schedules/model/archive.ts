import type { ScheduleSummary } from "../data/api";

/**
 * View model for one row of the schedule inventory.
 *
 * Fields the API has not filled in yet
 * (`input_operation_count`, `makespan`) render as placeholders rather than
 * zeros, so a summary never invents numbers.
 */
export interface ScheduleRow {
    id: string;
    status: "confirmed" | "draft" | "discarded";
    strategy: string;
    createdAt: string;
    confirmedAt: string | null;
    confirmedByUserId: string | null;
    opsCount: number | null;
    makespanMins: number | null;
}

export function toScheduleRow(schedule: ScheduleSummary): ScheduleRow {
    return {
        id: schedule.id,
        status: schedule.status,
        strategy: schedule.strategy,
        createdAt: schedule.created_at,
        confirmedAt: schedule.confirmed_at,
        confirmedByUserId: schedule.confirmed_by_user_id,
        opsCount: schedule.input_operation_count,
        makespanMins: schedule.makespan,
    };
}

/** `2026-09-15T14:22:00Z` → `15 Sep, 14:22`, in the reader's timezone. */
export function formatCreatedAt(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    return at.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/** The first UUID segment: enough to quote a run, short enough to read. */
export function shortScheduleId(id: string): string {
    return id.split("-")[0] ?? id;
}

/** A filter is "active" when anything other than the defaults is chosen. */
export function isFilterActive(status: string, strategy: string, query: string): boolean {
    return status !== "all" || strategy !== "any" || query.trim() !== "";
}

export type ScheduleSortKey = "newest" | "oldest" | "makespan-asc" | "makespan-desc";

/** Client-side sort over the fetched summaries; null makespans sort last. */
export function sortScheduleRows(rows: ScheduleRow[], sort: ScheduleSortKey): ScheduleRow[] {
    const sorted = [...rows];
    const byCreated = (left: ScheduleRow, right: ScheduleRow) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    const byMakespan = (left: ScheduleRow, right: ScheduleRow) =>
        (left.makespanMins ?? Number.POSITIVE_INFINITY) - (right.makespanMins ?? Number.POSITIVE_INFINITY);
    switch (sort) {
        case "oldest":
            sorted.sort((left, right) => byCreated(right, left));
            break;
        case "makespan-asc":
            sorted.sort(byMakespan);
            break;
        case "makespan-desc":
            sorted.sort((left, right) => byMakespan(right, left));
            break;
        default:
            sorted.sort(byCreated);
    }
    return sorted;
}
