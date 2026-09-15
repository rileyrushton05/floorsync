export const jobKeys = {
    all: ["jobs"] as const,
    definitions: ["job-definitions"] as const,
    definition: (id: string) => ["job-definitions", id] as const,
};
