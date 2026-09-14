import type { JobDef, Machine } from "./types";

export const SEED_MACHINES: Machine[] = [
    { id: "m-a", name: "Machine A", operator: "Anita Sandburg", active: true },
    { id: "m-b", name: "Machine B", operator: "Chelsea Okoro", active: true },
    { id: "m-c", name: "Machine C", operator: "Fiona Alvarez", active: true },
    { id: "m-d", name: "Machine D", operator: "George Whitlam", active: true },
];

/**
 * A starting backlog so the planning flow has something to show on first load.
 * Jobs are independent; operation order inside each job carries its process flow.
 */
export const SEED_JOBS: JobDef[] = [
    {
        id: "JOB-254",
        name: "Dryer not working",
        priority: "High",
        operations: [
            { id: "JOB-254-1", name: "Load material", machineId: "m-a", durationMins: 30 },
            { id: "JOB-254-2", name: "Adjust tension", machineId: "m-b", durationMins: 90 },
            { id: "JOB-254-3", name: "Quality check", machineId: "m-c", durationMins: 45 },
            { id: "JOB-254-4", name: "Final test", machineId: "m-b", durationMins: 60 },
            { id: "JOB-254-5", name: "Unload & clean", machineId: "m-a", durationMins: 30 },
        ],
    },
    {
        id: "JOB-255",
        name: "Washing machine issue",
        priority: "Med",
        operations: [
            { id: "JOB-255-1", name: "Diagnose fault", machineId: "m-c", durationMins: 45 },
            { id: "JOB-255-2", name: "Replace belt", machineId: "m-a", durationMins: 75 },
            { id: "JOB-255-3", name: "Test cycle", machineId: "m-b", durationMins: 60 },
            { id: "JOB-255-4", name: "Final inspection", machineId: "m-c", durationMins: 30 },
        ],
    },
    {
        id: "JOB-256",
        name: "Forklift maintenance",
        priority: "Low",
        operations: [
            { id: "JOB-256-1", name: "Safety check", machineId: "m-d", durationMins: 30 },
            { id: "JOB-256-2", name: "Repair hydraulics", machineId: "m-d", durationMins: 120 },
            { id: "JOB-256-3", name: "Test drive", machineId: "m-d", durationMins: 45 },
        ],
    },
    {
        id: "JOB-257",
        name: "Conveyor belt check",
        priority: "Med",
        operations: [
            { id: "JOB-257-1", name: "Safety lockout", machineId: "m-d", durationMins: 20 },
            { id: "JOB-257-2", name: "Inspect rollers", machineId: "m-c", durationMins: 60 },
            { id: "JOB-257-3", name: "Lubricate chain", machineId: "m-a", durationMins: 40 },
            { id: "JOB-257-4", name: "Test run", machineId: "m-b", durationMins: 45 },
            { id: "JOB-257-5", name: "Sign off", machineId: "m-c", durationMins: 20 },
        ],
    },
    {
        id: "JOB-258",
        name: "Tool replacement",
        priority: "High",
        operations: [
            { id: "JOB-258-1", name: "Remove old tool", machineId: "m-a", durationMins: 25 },
            { id: "JOB-258-2", name: "Install new tool", machineId: "m-a", durationMins: 50 },
        ],
    },
];
