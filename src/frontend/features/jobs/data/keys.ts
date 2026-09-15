export const jobKeys = {
    all: ["jobs"] as const,
    definitions: ["job-definitions"] as const,
    definition: (id: string) => ["job-definitions", id] as const,
    /** Every job's precedence edges — the prefix a save invalidates. */
    dependenciesAll: ["job-dependencies"] as const,
    /** One job's precedence edges. Per-job because the API is per-job. */
    dependencies: (id: string) => ["job-dependencies", id] as const,
};
