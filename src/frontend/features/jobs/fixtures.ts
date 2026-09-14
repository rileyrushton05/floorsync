import type { JobDef } from "@/app/manager/_lib/types";

/** Fixture backlog for isolated job-builder UI review. */
export const jobFixtures = {
    ready: [
        {
            id: "job-widget",
            name: "Widget assembly",
            priority: "High",
            operations: [
                {
                    id: "op-cut",
                    name: "Cut material",
                    machineId: "machine-press",
                    durationMins: 30,
                    routes: [{ machineId: "machine-press", durationMins: 30, energy: null }],
                },
            ],
        },
    ] satisfies JobDef[],
    emptyMessage: "No jobs yet. Create one to get started.",
    validationError: "Add at least one operation.",
} as const;
