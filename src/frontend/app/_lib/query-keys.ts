/** Stable, credential-free identifiers for cached FastAPI resources. */
export const queryKeys = {
    jobs: {
        all: ["jobs"] as const,
    },
    machines: {
        all: ["machines"] as const,
        detail: (id: string) => ["machines", id] as const,
        categories: ["machines", "categories"] as const,
    },
    jobDefinitions: {
        all: ["job-definitions"] as const,
        detail: (id: string) => ["job-definitions", id] as const,
    },
    schedules: {
        all: ["schedules"] as const,
        timeline: (id: string) => ["schedules", id, "timeline"] as const,
        generation: (id: string) => ["schedule-generations", id] as const,
    },
    simulations: {
        detail: (id: string) => ["simulations", id] as const,
    },
};
