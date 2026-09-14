export const machineKeys = {
    all: ["machines"] as const,
    detail: (id: string) => ["machines", id] as const,
    categories: ["machines", "categories"] as const,
};
