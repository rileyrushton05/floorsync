export const operatorKeys = {
    activeSimulation: ["operator", "active-simulation"] as const,
    timeline: (scheduleId: string) => ["operator", "timeline", scheduleId] as const,
};
