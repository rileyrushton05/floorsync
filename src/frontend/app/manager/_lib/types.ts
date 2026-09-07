/**
 * Domain model for the manager planning flow.
 *
 * The flow is deliberately *not* clock-driven: a manager defines jobs and the
 * dependencies between them, picks which ones to release, and the generator
 * lays them out. Every time in a generated schedule is therefore **minutes
 * elapsed from T+0**, the moment the plan is released — never a wall clock.
 */

export type Priority = "High" | "Med" | "Low";

export interface Machine {
    id: string;
    name: string;
    operator: string;
}

/** One step of a job. Steps run in array order; each occupies one machine. */
export interface OperationDef {
    id: string;
    name: string;
    machineId: string;
    durationMins: number;
}

export interface JobDef {
    id: string;
    name: string;
    priority: Priority;
    /** Ordered chain — operation n+1 cannot start until operation n finishes. */
    operations: OperationDef[];
    /** Ids of jobs that must finish before this job's first operation starts. */
    dependsOn: string[];
}

/** One operation, placed on a machine at a concrete offset from T+0. */
export interface ScheduledOperation {
    jobId: string;
    opId: string;
    opName: string;
    /** 1-based position within the job. */
    opIndex: number;
    opTotal: number;
    machineId: string;
    startMins: number;
    endMins: number;
}

export interface MachineLoad {
    machineId: string;
    busyMins: number;
    /** Share of the makespan this machine spends working. */
    utilisationPct: number;
}

export interface GeneratedSchedule {
    ops: ScheduledOperation[];
    /** Job ids in the order the generator placed them; explains the layout. */
    order: string[];
    jobStart: Record<string, number>;
    jobFinish: Record<string, number>;
    machineLoad: MachineLoad[];
    /** Total elapsed time from T+0 to the last operation finishing. */
    makespanMins: number;
    generatedAt: string;
}

export type ScheduleResult =
    | { ok: true; schedule: GeneratedSchedule }
    | { ok: false; errors: string[] };
