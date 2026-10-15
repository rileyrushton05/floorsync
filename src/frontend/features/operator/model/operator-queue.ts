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
    /** Every operation on the machine, planned into work stretches and the breaks between them. */
    segments: ShiftSegment[];
}

/** Operations planned back to back, with no idle time between them. */
export interface WorkStretch {
    kind: "work";
    key: string;
    startMins: number;
    endMins: number;
    operations: OperatorOperation[];
}

/** Planned idle time on the machine between two work stretches. */
export interface BreakPeriod {
    kind: "break";
    key: string;
    startMins: number;
    endMins: number;
}

export type ShiftSegment = WorkStretch | BreakPeriod;

/** Gaps shorter than this are rounding between back-to-back operations, not a break. */
const MIN_BREAK_MINS = 1;

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
        segments: shiftSegments(mine),
    };
}

/**
 * Split a machine's operations, sorted by start, into continuous work and breaks.
 *
 * Operations that touch or overlap (a machine with more than one slot) belong to
 * the same stretch; any gap of at least `MIN_BREAK_MINS` ends it.
 */
export function shiftSegments(operations: readonly OperatorOperation[]): ShiftSegment[] {
    const segments: ShiftSegment[] = [];
    let stretch: WorkStretch | null = null;
    for (const operation of operations) {
        if (stretch && operation.startMins - stretch.endMins < MIN_BREAK_MINS) {
            stretch.operations.push(operation);
            stretch.endMins = Math.max(stretch.endMins, operation.endMins);
            continue;
        }
        if (stretch) {
            segments.push({ kind: "break", key: `break:${operation.key}`, startMins: stretch.endMins, endMins: operation.startMins });
        }
        stretch = {
            kind: "work",
            key: `work:${operation.key}`,
            startMins: operation.startMins,
            endMins: operation.endMins,
            operations: [operation],
        };
        segments.push(stretch);
    }
    return segments;
}

/**
 * What is left after the current operation, still grouped into stretches and breaks.
 *
 * Operations are completed strictly in queue order, so everything after the
 * current operation's stretch is still to do; that stretch keeps only the
 * operations after the current one, and may be left empty.
 */
export function upcomingSegments(queue: OperatorQueue): ShiftSegment[] {
    const index = currentStretchIndex(queue);
    if (index < 0) return [];
    const stretch = queue.segments[index] as WorkStretch;
    const upcoming = new Set(queue.upcoming);
    return [
        { ...stretch, operations: stretch.operations.filter((operation) => upcoming.has(operation)) },
        ...queue.segments.slice(index + 1),
    ];
}

export type ShiftStatus =
    /** Before the machine's first operation is due: nothing has been planned yet, so it is not a break. */
    | { kind: "not-started"; leftMins: number; startsAtMins: number }
    /**
     * Before the current operation is due. `planned` is false when the operator is
     * only ahead of the plan inside a stretch, rather than on a scheduled break.
     */
    | { kind: "break"; planned: boolean; leftMins: number; lengthMins: number; progressPct: number; resumesAtMins: number }
    /** Inside the current stretch; `behind` once the current operation is past its planned end. */
    | {
          kind: "working";
          leftMins: number;
          behind: boolean;
          stretchEndMins: number;
          stretchLengthMins: number;
          nextBreak: BreakPeriod | null;
      };

/**
 * Whether the operator is on a break or working now, and for how much longer.
 *
 * Null when there is nothing left to do or no clock to measure against.
 */
export function shiftStatus(queue: OperatorQueue, nowMins: number | null): ShiftStatus | null {
    const current = queue.current;
    const index = currentStretchIndex(queue);
    if (!current || index < 0 || nowMins === null) return null;
    const stretch = queue.segments[index] as WorkStretch;

    if (nowMins < current.startMins) {
        const planned = stretch.operations[0] === current;
        if (planned && index === 0) {
            return { kind: "not-started", leftMins: current.startMins - nowMins, startsAtMins: current.startMins };
        }
        const breakStart = planned ? queue.segments[index - 1].startMins : nowMins;
        const lengthMins = current.startMins - breakStart;
        return {
            kind: "break",
            planned,
            leftMins: current.startMins - nowMins,
            lengthMins,
            progressPct: lengthMins <= 0 ? 0 : Math.max(0, Math.min(100, ((nowMins - breakStart) / lengthMins) * 100)),
            resumesAtMins: current.startMins,
        };
    }

    const next = queue.segments[index + 1];
    return {
        kind: "working",
        leftMins: Math.max(0, stretch.endMins - nowMins),
        behind: nowMins >= current.endMins,
        stretchEndMins: stretch.endMins,
        stretchLengthMins: stretch.endMins - stretch.startMins,
        nextBreak: next?.kind === "break" ? next : null,
    };
}

function currentStretchIndex(queue: OperatorQueue): number {
    const current = queue.current;
    if (!current) return -1;
    return queue.segments.findIndex((segment) => segment.kind === "work" && segment.operations.includes(current));
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
