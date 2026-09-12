/**
 * Domain model for the manager planning flow.
 *
 * The flow is deliberately *not* clock-driven: a manager defines independent
 * jobs and their ordered operations, then the generator lays them out. Every
 * time in a generated schedule is therefore **minutes
 * elapsed from T+0**, the moment the plan is released — never a wall clock.
 */

export type Priority = "High" | "Med" | "Low";

export interface Machine {
    id: string;
    name: string;
    operator: string;
}

/** One compatible machine route for an operation. */
export interface OperationRoute {
    machineId: string;
    durationMins: number;
    /** The API serialises decimal energy values as strings. */
    energy: string | null;
}

/** One step of a job. Steps run in array order; each occupies one machine. */
export interface OperationDef {
    id: string;
    name: string;
    machineId: string;
    durationMins: number;
    /**
     * Every route returned by the builder API. The current editor exposes the
     * primary route and preserves the remaining compatible routes on save.
     */
    routes?: OperationRoute[];
}

export interface JobDef {
    id: string;
    name: string;
    priority: Priority;
    /** Ordered chain — operation n+1 cannot start until operation n finishes. */
    operations: OperationDef[];
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
