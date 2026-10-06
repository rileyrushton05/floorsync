export const scheduleKeys = {
    all: ["schedules"] as const,
    timeline: (id: string) => ["schedules", id, "timeline"] as const,
    simulation: (scheduleId: string) => ["schedules", scheduleId, "simulation"] as const,
    generation: (id: string) => ["schedule-generations", id] as const,
    validation: (jobIds: readonly string[]) => ["schedules", "validation", ...[...jobIds].sort()] as const,
};
