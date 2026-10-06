import type { GeneratedSchedule, Machine } from "@/domains/scheduling/types";
import type { SimulationPosition } from "../data/api";

/**
 * View model for the Simulation page.
 *
 * Everything here is a pure read of a confirmed plan at one simulated minute.
 * The minute itself comes from the API's event-sourced position; the only
 * arithmetic the browser adds is carrying that position forward between reads
 * at the speed the API reported, so the clock moves smoothly instead of in
 * one-read steps.
 */

export const SPEEDS = [
    { value: 1, label: "1×", hint: "1 simulated minute per second" },
    { value: 10, label: "10×", hint: "10 simulated minutes per second" },
    { value: 60, label: "60×", hint: "1 simulated hour per second" },
] as const;

export const DEFAULT_SPEED = 10;

/** How far the step buttons move the clock, in simulated minutes. */
export const STEP_MINS = 15;

export type PlaybackStatus = "not_started" | "running" | "paused" | "complete";

/**
 * The simulated minute a position reached `nowMs`, given it was read at
 * `readAtMs` (both browser clock). Reading against the browser's own receipt
 * time rather than the API's `derived_at` keeps a skewed client clock from
 * shifting the play head.
 */
export function interpolatedMinutes(position: SimulationPosition, readAtMs: number, nowMs: number): number {
    const makespan = position.makespan;
    const speed = Number(position.speed);
    if (!position.is_running || !Number.isFinite(speed)) {
        return clamp(position.simulated_time, 0, makespan);
    }
    const elapsedSeconds = Math.max(0, (nowMs - readAtMs) / 1000);
    return clamp(position.simulated_time + elapsedSeconds * speed, 0, makespan);
}

/** The playback state a manager should see, folding the derived flags into one word. */
export function playbackStatus(position: SimulationPosition | null): PlaybackStatus {
    if (position === null || position.status === "not_started") return "not_started";
    if (position.is_complete || position.status === "complete") return "complete";
    if (position.is_running) return "running";
    return "paused";
}

export const PLAYBACK_LABEL: Record<PlaybackStatus, string> = {
    not_started: "Not started",
    running: "Running",
    paused: "Paused",
    complete: "Complete",
};

export const PLAYBACK_INTENT = {
    not_started: "secondary",
    running: "info",
    paused: "warning",
    complete: "success",
} as const;

export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

// ── What the floor is doing ────────────────────────────────────────────────

export type MachineActivity =
    | {
        kind: "running";
        jobId: string;
        opName: string;
        opIndex: number;
        opTotal: number;
        progressPct: number;
        endMins: number;
    }
    | { kind: "idle"; nextStartMins: number }
    | { kind: "finished" }
    | { kind: "waiting"; firstStartMins: number };

export interface MachineNow {
    machine: Machine;
    activity: MachineActivity;
    doneCount: number;
    totalCount: number;
}

/**
 * Each machine the plan uses, and what it is doing at `nowMins`. `null` means
 * the simulation has not started, so every machine is waiting for its first
 * operation rather than idle.
 */
export function machinesAt(schedule: GeneratedSchedule, machines: Machine[], nowMins: number | null): MachineNow[] {
    const byMachine = new Map<string, GeneratedSchedule["ops"]>();
    for (const op of schedule.ops) {
        const ops = byMachine.get(op.machineId);
        if (ops) ops.push(op);
        else byMachine.set(op.machineId, [op]);
    }

    return machines.flatMap<MachineNow>((machine) => {
        const ops = byMachine.get(machine.id);
        if (!ops || ops.length === 0) return [];
        const firstStartMins = Math.min(...ops.map((op) => op.startMins));
        if (nowMins === null) {
            return [{ machine, activity: { kind: "waiting", firstStartMins }, doneCount: 0, totalCount: ops.length }];
        }
        const doneCount = ops.filter((op) => op.endMins <= nowMins).length;
        const running = ops.find((op) => op.startMins <= nowMins && op.endMins > nowMins);
        let activity: MachineActivity;
        if (running) {
            activity = {
                kind: "running",
                jobId: running.jobId,
                opName: running.opName,
                opIndex: running.opIndex,
                opTotal: running.opTotal,
                progressPct: ((nowMins - running.startMins) / (running.endMins - running.startMins)) * 100,
                endMins: running.endMins,
            };
        } else {
            const upcoming = ops.filter((op) => op.startMins > nowMins);
            activity = upcoming.length === 0
                ? { kind: "finished" }
                : { kind: "idle", nextStartMins: Math.min(...upcoming.map((op) => op.startMins)) };
        }
        return [{ machine, activity, doneCount, totalCount: ops.length }];
    });
}

export type JobState = "waiting" | "running" | "done";

export interface JobNow {
    jobId: string;
    name: string;
    state: JobState;
    doneCount: number;
    totalCount: number;
    startMins: number;
    finishMins: number;
}

/** Each scheduled job, in plan order, and how far it has got at `nowMins`. */
export function jobsAt(
    schedule: GeneratedSchedule,
    jobName: (jobId: string) => string,
    nowMins: number | null,
): JobNow[] {
    return schedule.order.map((jobId) => {
        const ops = schedule.ops.filter((op) => op.jobId === jobId);
        const startMins = schedule.jobStart[jobId] ?? 0;
        const finishMins = schedule.jobFinish[jobId] ?? 0;
        const doneCount = nowMins === null ? 0 : ops.filter((op) => op.endMins <= nowMins).length;
        const state: JobState = nowMins === null || nowMins < startMins
            ? "waiting"
            : nowMins >= finishMins ? "done" : "running";
        return { jobId, name: jobName(jobId), state, doneCount, totalCount: ops.length, startMins, finishMins };
    });
}

export interface FloorTotals {
    opsDone: number;
    opsRunning: number;
    opsTotal: number;
    jobsDone: number;
    jobsTotal: number;
    machinesBusy: number;
    machinesTotal: number;
}

export function floorTotals(schedule: GeneratedSchedule, machines: MachineNow[], jobs: JobNow[], nowMins: number | null): FloorTotals {
    return {
        opsDone: nowMins === null ? 0 : schedule.ops.filter((op) => op.endMins <= nowMins).length,
        opsRunning: nowMins === null ? 0 : schedule.ops.filter((op) => op.startMins <= nowMins && op.endMins > nowMins).length,
        opsTotal: schedule.ops.length,
        jobsDone: jobs.filter((job) => job.state === "done").length,
        jobsTotal: jobs.length,
        machinesBusy: machines.filter((machine) => machine.activity.kind === "running").length,
        machinesTotal: machines.length,
    };
}
