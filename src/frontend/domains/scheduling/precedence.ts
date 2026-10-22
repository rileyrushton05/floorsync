/**
 * Precedence between a job's operations, as a layout needs it: which steps
 * wait on which, and how deep each sits in the graph. Shared by the job
 * builder and the import preview, which both draw a job's graph.
 */
export interface PrecedenceNode {
    id: string;
    /** Ids of operations in the same job that must finish first. */
    dependsOn: string[];
}

/**
 * The earliest round each operation could run in, counting from zero.
 *
 * `level(op) = 1 + max(level of its predecessors)`, so everything on the same
 * level is independent and could run at once. This is what makes a graph
 * legible as a picture — it is a layout, not a schedule, and says nothing about
 * machine contention or duration.
 */
export function levelsOf(nodes: readonly PrecedenceNode[]): Map<string, number> {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const levels = new Map<string, number>();
    const visiting = new Set<string>();

    function level(id: string): number {
        const cached = levels.get(id);
        if (cached !== undefined) return cached;
        // A cycle cannot be laid out; the API refuses to store one, and this
        // only has to avoid looping forever while the draft is mid-edit.
        if (visiting.has(id)) return 0;
        visiting.add(id);
        const predecessors = byId.get(id)?.dependsOn ?? [];
        const value = predecessors.length === 0 ? 0 : 1 + Math.max(...predecessors.map(level));
        visiting.delete(id);
        levels.set(id, value);
        return value;
    }

    for (const node of nodes) level(node.id);
    return levels;
}

/** Operations grouped by level, each group in the job's own operation order. */
export function levelGroups(nodes: readonly PrecedenceNode[]): PrecedenceNode[][] {
    const levels = levelsOf(nodes);
    const groups: PrecedenceNode[][] = [];
    for (const node of nodes) {
        const level = levels.get(node.id) ?? 0;
        (groups[level] ??= []).push(node);
    }
    return groups.map((group) => group ?? []);
}
