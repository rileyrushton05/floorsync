import type { ScheduleOption } from "./model";

/** Fixture props for picker, queued, rejected, and ready schedule UI states. */
export const scheduleFixtures = {
    options: [
        { id: "schedule-current", status: "confirmed", label: "ReSched · 4h 20m · 14 Sep, 09:30" },
        { id: "schedule-draft", status: "draft", label: "ReSched · no makespan · 13 Sep, 16:05" },
    ] satisfies ScheduleOption[],
    timelineSummary: { jobs: 4, machines: 6, operations: 18 },
    rejection: "A route references an inactive machine.",
} as const;
