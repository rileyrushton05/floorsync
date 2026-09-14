import type { MachineDraft, MachineRow } from "./model";

/** Design-review inputs: no API DTOs, auth, hooks, or network setup required. */
export const machineFixtures = {
    ready: [
        { id: "machine-press", name: "Hydraulic press", categoryLabel: "Pressing", active: true, statusLabel: "Active" },
        { id: "machine-legacy", name: "Legacy assembly station with an intentionally long name", categoryLabel: "Assembly", active: false, statusLabel: "Inactive" },
    ] satisfies MachineRow[],
    emptyDraft: { id: null, name: "", categoryId: null, salary: "", active: true } satisfies MachineDraft,
    validationError: "Give the machine a name.",
} as const;
