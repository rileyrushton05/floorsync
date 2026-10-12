import type { ScheduleTimeline, TimelineOperation } from "@/domains/scheduling/contracts";
import type { BacklogStatus } from "@/domains/scheduling/types";
import type { ScheduleSummary } from "@/features/schedules/data/api";

/**
 * Everything the manager overview shows, derived from data the API already
 * serves. Nothing here invents a figure: if the backend does not record it
 * (due dates, operator presence, machine faults), the overview does not show it.
 */

export const BACKLOG_ORDER: readonly BacklogStatus[] = ["open", "planned", "done", "archived"];

export function backlogCounts(statuses: readonly BacklogStatus[]): Record<BacklogStatus, number> {
    const counts: Record<BacklogStatus, number> = { open: 0, planned: 0, done: 0, archived: 0 };
    for (const status of statuses) counts[status] += 1;
    return counts;
}

export type JobState = "Waiting" | "In progress" | "Completed";

export interface JobStep {
    index: number;
    total: number;
    label: string;
    machineLabel: string;
    start: number;
    end: number;
}

export interface JobProgress {
    key: string;
    label: string;
    state: JobState;
    doneCount: number;
    totalCount: number;
    progressPct: number;
    current: JobStep | null;
    next: JobStep | null;
    steps: (JobStep & { state: "done" | "current" | "pending" })[];
}

/**
 * Each job's place in the schedule at `nowMins`.
 *
 * `nowMins` is null before the simulation starts, which reads as "nothing has
 * run yet" rather than as an error.
 */
export function jobProgress(timeline: ScheduleTimeline, nowMins: number | null): JobProgress[] {
    const machineLabels = new Map(timeline.machines.map((machine) => [machine.key, machine.label]));
    const byJob = groupBy(timeline.operations, (operation) => operation.job_key);
    const now = nowMins ?? -Infinity;

    return timeline.jobs.map((job) => {
        const chain = [...(byJob.get(job.key) ?? [])].sort((left, right) => left.start - right.start);
        const steps = chain.map((operation, i) => ({
            index: i + 1,
            total: chain.length,
            label: operation.label,
            machineLabel: machineLabels.get(operation.machine_key) ?? operation.machine_key,
            start: operation.start,
            end: operation.end,
            state: operation.end <= now ? "done" as const : operation.start <= now ? "current" as const : "pending" as const,
        }));
        const doneCount = steps.filter((step) => step.state === "done").length;
        const current = steps.find((step) => step.state === "current") ?? null;
        const next = steps.find((step) => step.state === "pending") ?? null;
        const state: JobState =
            steps.length > 0 && doneCount === steps.length ? "Completed"
                : current || doneCount > 0 ? "In progress"
                    : "Waiting";
        return {
            key: job.key,
            label: job.label,
            state,
            doneCount,
            totalCount: steps.length,
            progressPct: steps.length === 0 ? 0 : Math.round((doneCount / steps.length) * 100),
            current,
            next,
            steps,
        };
    });
}

export interface MachineLoad {
    key: string;
    label: string;
    /** Share of the makespan the machine spends working, across all its slots. */
    utilizationPct: number;
    busyNow: boolean;
}

export function machineLoad(timeline: ScheduleTimeline, nowMins: number | null): MachineLoad[] {
    const byMachine = groupBy(timeline.operations, (operation) => operation.machine_key);
    return timeline.machines.map((machine) => {
        const operations = byMachine.get(machine.key) ?? [];
        const slots = Math.max(1, ...operations.map((operation) => operation.machine_slot + 1));
        const busy = operations.reduce((total, operation) => total + (operation.end - operation.start), 0);
        const capacity = timeline.makespan * slots;
        return {
            key: machine.key,
            label: machine.label,
            utilizationPct: capacity === 0 ? 0 : Math.round((busy / capacity) * 100),
            busyNow: nowMins !== null && operations.some((operation) => operation.start <= nowMins && nowMins < operation.end),
        };
    });
}

/** The newest schedules that produced a plan, oldest first so they read left to right. */
export function recentMakespans(schedules: readonly ScheduleSummary[], limit = 8) {
    return schedules
        .filter((schedule) => schedule.status !== "discarded" && schedule.makespan !== null)
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .slice(-limit)
        .map((schedule) => ({
            id: schedule.id,
            strategy: schedule.strategy,
            status: schedule.status,
            makespan: schedule.makespan as number,
            createdAt: schedule.created_at,
        }));
}

/**
 * The schedule the overview describes: the one being simulated, else the most
 * recently confirmed one, else none.
 */
export function overviewScheduleId(
    activeScheduleId: string | null,
    schedules: readonly ScheduleSummary[],
): string | null {
    if (activeScheduleId) return activeScheduleId;
    const confirmed = schedules
        .filter((schedule) => schedule.status === "confirmed")
        .sort((left, right) => (right.confirmed_at ?? right.created_at).localeCompare(left.confirmed_at ?? left.created_at));
    return confirmed[0]?.id ?? null;
}

function groupBy(operations: readonly TimelineOperation[], key: (operation: TimelineOperation) => string) {
    const groups = new Map<string, TimelineOperation[]>();
    for (const operation of operations) {
        const group = groups.get(key(operation));
        if (group) group.push(operation);
        else groups.set(key(operation), [operation]);
    }
    return groups;
}
