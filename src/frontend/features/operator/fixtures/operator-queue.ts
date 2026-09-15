/** Prototype-only queue data until the operator API contract exists. */
export type OpStatus = "completed" | "running" | "pending";
export interface OperationStep { index: number; total: number; name: string; status: OpStatus; startedAt?: string; }
export interface ActiveJob { jobId: string; title: string; ops: OperationStep[]; }
export interface QueuedJob { jobId: string; title: string; ops: OperationStep[]; estTime: string; estStart: string; }
export interface CompletedEntry { key: string; jobId: string; label: string; completedAt: string; duration: string; }
export interface MachineState {
    name: string; activeJob: ActiveJob | null; queue: QueuedJob[]; completed: CompletedEntry[];
    shiftRemaining: string; shiftTotal: string; shiftPct: number; nextBreakRemaining: string; nextBreakAt: string;
}

function makeOps(names: string[], runningIndex: number, startedAt?: string): OperationStep[] {
    return names.map((name, index) => ({ index: index + 1, total: names.length, name, status: index < runningIndex ? "completed" : index === runningIndex ? "running" : "pending", startedAt: index === runningIndex ? startedAt : undefined }));
}

export const initialMachine: MachineState = {
    name: "Machine B",
    activeJob: { jobId: "#254", title: "Dryer not working", ops: makeOps(["Load Material", "Adjusting Tension", "Quality Check", "Final Test", "Unload & Clean"], 1, "09:58 AM") },
    queue: [
        { jobId: "#255", title: "Washing Machine Issue", estTime: "02:00", estStart: "11:02 AM", ops: makeOps(["Diagnose Fault", "Replace Belt", "Test Cycle", "Final Inspection"], -1) },
        { jobId: "#256", title: "Forklift Maintenance", estTime: "01:00", estStart: "01:05 PM", ops: makeOps(["Safety Check", "Repair Hydraulics", "Test Drive"], -1) },
        { jobId: "#258", title: "Tool Replacement", estTime: "02:00", estStart: "02:05 PM", ops: makeOps(["Remove Old Tool", "Install New Tool"], -1) },
    ],
    completed: [
        { key: "c1", jobId: "#254", label: "Op 1 of 5 • Load Material", completedAt: "09:58 AM", duration: "00:12" },
        { key: "c2", jobId: "#253", label: "Op 3 of 3 • Final Test", completedAt: "09:34 AM", duration: "00:18" },
    ],
    shiftRemaining: "03:35", shiftTotal: "08:00", shiftPct: 55, nextBreakRemaining: "00:56", nextBreakAt: "10:30 AM",
};
