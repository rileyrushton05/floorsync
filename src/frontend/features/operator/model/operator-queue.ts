import type { ScheduleTimeline } from "@/domains/scheduling/contracts";

/** One operation on the operator's machine, with its place in its job. */
export interface OperatorOperation {
    key: string;
    jobLabel: string;
    label: string;
    /** 1-based position within the job, by start time across every machine. */
    opIndex: number;
    opTotal: number;
    startMins: number;
    endMins: number;
}

export interface OperatorQueue {
    machineLabel: string | null;
    /** The first operation not yet marked complete, or null when the machine is done. */
    current: OperatorOperation | null;
    upcoming: OperatorOperation[];
    completedCount: number;
    totalCount: number;
}

/**
 * Cut a schedule timeline down to one machine's queue.
 *
 * Nothing here recomputes a time: starts and ends are the backend's. What is
 * derived is only "which of this machine's operations is next", from the set the
 * operator has marked complete.
 */
export function buildOperatorQueue(
    timeline: ScheduleTimeline,
    machineKey: string,
    completedKeys: ReadonlySet<string>,
): OperatorQueue {
    const jobLabels = new Map(timeline.jobs.map((job) => [job.key, job.label]));

    const byJob = new Map<string, ScheduleTimeline["operations"]>();
    for (const operation of timeline.operations) {
        const chain = byJob.get(operation.job_key);
        if (chain) chain.push(operation);
        else byJob.set(operation.job_key, [operation]);
    }
    for (const chain of byJob.values()) chain.sort((left, right) => left.start - right.start);

    const mine: OperatorOperation[] = timeline.operations
        .filter((operation) => operation.machine_key === machineKey)
        .map((operation) => {
            const chain = byJob.get(operation.job_key) ?? [];
            return {
                key: operation.key,
                jobLabel: jobLabels.get(operation.job_key) ?? operation.job_key,
                label: operation.label,
                opIndex: chain.findIndex((item) => item.key === operation.key) + 1,
                opTotal: chain.length,
                startMins: operation.start,
                endMins: operation.end,
            };
        })
        .sort((left, right) => left.startMins - right.startMins || left.key.localeCompare(right.key));

    const remaining = mine.filter((operation) => !completedKeys.has(operation.key));
    return {
        machineLabel: timeline.machines.find((machine) => machine.key === machineKey)?.label ?? null,
        current: remaining[0] ?? null,
        upcoming: remaining.slice(1),
        completedCount: mine.length - remaining.length,
        totalCount: mine.length,
    };
}

/**
 * Where the simulation clock is now, in schedule minutes.
 *
 * The API gives the position as of `derived_at`; while the simulation runs the
 * clock keeps moving at `speed` schedule minutes per real second (1× = 1 min/s),
 * so the screen advances it locally between refetches rather than polling.
 */
export function simulatedMinutes(
    simulation: { simulated_time: number; speed: string; is_running: boolean; derived_at: string; makespan: number },
    nowMs: number,
): number {
    const speed = Number(simulation.speed);
    const elapsedSeconds = simulation.is_running && Number.isFinite(speed)
        ? Math.max(0, (nowMs - Date.parse(simulation.derived_at)) / 1000)
        : 0;
    const advance = Number.isFinite(speed) ? elapsedSeconds * speed : 0;
    return Math.min(simulation.makespan, simulation.simulated_time + advance);
}

export type OperationTiming =
    | { kind: "unscheduled" }
    | { kind: "waiting"; startsInMins: number }
    | { kind: "in-progress"; endsInMins: number; progressPct: number }
    | { kind: "delayed"; lateByMins: number };

/**
 * Where an unfinished operation sits against the simulation clock.
 *
 * An operation still open after its planned end is *delayed*; one inside its
 * window is in progress. `nowMins` is null until the simulation has started, when
 * there is no clock to be late against.
 */
export function operationTiming(operation: OperatorOperation, nowMins: number | null): OperationTiming {
    if (nowMins === null) return { kind: "unscheduled" };
    if (nowMins < operation.startMins) return { kind: "waiting", startsInMins: operation.startMins - nowMins };
    if (nowMins >= operation.endMins) return { kind: "delayed", lateByMins: nowMins - operation.endMins };
    const length = operation.endMins - operation.startMins;
    return {
        kind: "in-progress",
        endsInMins: operation.endMins - nowMins,
        progressPct: length === 0 ? 100 : ((nowMins - operation.startMins) / length) * 100,
    };
}
