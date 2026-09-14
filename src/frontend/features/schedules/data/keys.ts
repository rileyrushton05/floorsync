export const scheduleKeys = {
    all: ["schedules"] as const,
    timeline: (id: string) => ["schedules", id, "timeline"] as const,
    generation: (id: string) => ["schedule-generations", id] as const,
};
