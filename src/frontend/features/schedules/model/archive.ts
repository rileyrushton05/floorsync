import type { ScheduleStrategy, ScheduleSummary } from "../data/api";

/**
 * View model for one row of the schedule inventory.
 *
 * Fields the API has not filled in yet
 * (`input_operation_count`, `makespan`) render as placeholders rather than
 * zeros, so a summary never invents numbers.
 */
export interface ScheduleRow {
    id: string;
    /** What the manager called it, or null for a draft nobody has saved yet. */
    name: string | null;
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
        name: schedule.name,
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

/** The longest name the API accepts, after trimming. */
export const SCHEDULE_NAME_MAX = 120;

/**
 * The name a schedule is shown under. An unsaved draft has none, so it is
 * labelled as such rather than by a UUID nobody can tell apart.
 */
export function scheduleDisplayName(schedule: { name: string | null; status: ScheduleRow["status"] }): string {
    if (schedule.name) return schedule.name;
    return schedule.status === "draft" ? "Untitled draft" : "Untitled schedule";
}

/**
 * Which engine produced a run.
 *
 * The API stores the engine's versioned identifier (`resched_reinforce_v1`,
 * `gurobi_exact_v1`), not the `resched` / `exact` a run is requested with, so
 * filtering and labelling go through this rather than comparing strings.
 */
export function strategyFamily(strategy: string): ScheduleStrategy | null {
    const value = strategy.toLowerCase();
    if (value.startsWith("resched")) return "resched";
    if (value.includes("exact") || value.includes("gurobi")) return "exact";
    return null;
}

export function strategyLabel(strategy: string): string {
    switch (strategyFamily(strategy)) {
        case "resched":
            return "ReSched";
        case "exact":
            return "Exact";
        default:
            return strategy;
    }
}

/**
 * The colour that identifies a schedule's engine, from the theme's categorical
 * chart tokens: blue for ReSched, orange for Exact.
 *
 * Everything that renders a schedule by strategy — chart bars, legend swatches,
 * list dots — must come through here, so the same schedule is the same colour
 * everywhere. Goes through `strategyFamily` because stored strategies are
 * versioned identifiers (`resched_reinforce_v1`), not the bare family names.
 */
export function strategyColor(strategy: string): string {
    switch (strategyFamily(strategy)) {
        case "resched":
            return "var(--chart-1)";
        case "exact":
            return "var(--chart-2)";
        default:
            return "var(--chart-4)";
    }
}

/** A filter is "active" when anything other than the defaults is chosen. */
export function isFilterActive(status: string, strategy: string, query: string): boolean {
    return status !== "all" || strategy !== "any" || query.trim() !== "";
}

/** Case-insensitive match on name, short id, or strategy (raw or labelled). */
export function matchesScheduleQuery(row: ScheduleRow, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [scheduleDisplayName(row), row.id, row.strategy, strategyLabel(row.strategy)].some((value) =>
        value.toLowerCase().includes(needle),
    );
}

export type ScheduleSortKey = "newest" | "oldest" | "name" | "makespan-asc" | "makespan-desc";

/** Client-side sort over the fetched summaries; null makespans and names sort last. */
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
        case "name":
            sorted.sort((left, right) => {
                if (left.name === null || right.name === null) {
                    return left.name === right.name ? byCreated(left, right) : left.name === null ? 1 : -1;
                }
                return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
            });
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
