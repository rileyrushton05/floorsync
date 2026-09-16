import type { DependencyEdge } from "../data/api";

/**
 * Precedence between operations, as the builder edits it.
 *
 * The API models precedence as a list of edges; the editor wants "what does
 * this operation wait on", which is the same graph indexed by its `after` side.
 * Everything here converts between the two and answers questions about the
 * shape — nothing validates. The API owns whether a graph is acceptable, and
 * the scheduling engine owns whether it can plan one.
 *
 * Scope is deliberately within-job: the database allows an edge from an
 * operation in another job, but this editor cannot draw one, so a foreign
 * predecessor is kept out of the picture. It is *not* discarded — the ordering
 * endpoint replaces every edge pointing into this job, so a save that forgot
 * them would delete precedence the manager never saw and never asked to change.
 * `foreignEdgesFor` carries them through a save untouched; the editor says how
 * many there are without pretending it can lay them out.
 */
export interface PrecedenceNode {
    id: string;
    /** Ids of operations in the same job that must finish first. */
    dependsOn: string[];
}

/** Each operation waits on the one before it — the straight chain, and the default. */
export function chainDependsOn(operationIds: readonly string[]): Map<string, string[]> {
    return new Map(operationIds.map((id, index) => [id, index === 0 ? [] : [operationIds[index - 1]]]));
}

/**
 * Read a job's edges into per-operation predecessors.
 *
 * Only edges between two of this job's own operations become `dependsOn`; the
 * graph is the one thing the diagram can draw. See `foreignEdgesFor` for what
 * happens to the rest.
 */
export function dependsOnFromEdges(
    operationIds: readonly string[],
    edges: readonly DependencyEdge[],
): Map<string, string[]> {
    const own = new Set(operationIds);
    const result = new Map<string, string[]>(operationIds.map((id) => [id, []]));
    for (const edge of edges) {
        if (!own.has(edge.after_operation_id) || !own.has(edge.before_operation_id)) continue;
        result.get(edge.after_operation_id)?.push(edge.before_operation_id);
    }
    // Keep predecessors in the job's own operation order so the UI is stable.
    for (const [id, predecessors] of result) {
        result.set(id, operationIds.filter((candidate) => predecessors.includes(candidate)));
    }
    return result;
}

/**
 * The job's edges that the diagram cannot draw: a predecessor in another job.
 *
 * Returned so a save can send them back exactly as they were. Anything whose
 * `after` side is no longer one of `operationIds` is left out — that operation
 * is being deleted, and the database would cascade the edge away regardless.
 */
export function foreignEdgesFor(
    operationIds: readonly string[],
    edges: readonly DependencyEdge[],
): DependencyEdge[] {
    const own = new Set(operationIds);
    return edges.filter(
        (edge) => own.has(edge.after_operation_id) && !own.has(edge.before_operation_id),
    );
}

/** Flatten back into the edge list the API accepts. */
export function edgesFromNodes(nodes: readonly PrecedenceNode[]): DependencyEdge[] {
    return nodes.flatMap((node) =>
        node.dependsOn.map((before) => ({
            before_operation_id: before,
            after_operation_id: node.id,
        })),
    );
}

/** Every operation reachable by following `dependsOn` backwards from `id`. */
function ancestorsOf(nodes: readonly PrecedenceNode[], id: string): Set<string> {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const seen = new Set<string>();
    const stack = [...(byId.get(id)?.dependsOn ?? [])];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined || seen.has(current)) continue;
        seen.add(current);
        stack.push(...(byId.get(current)?.dependsOn ?? []));
    }
    return seen;
}

/**
 * Whether making `candidate` a predecessor of `operationId` would close a loop.
 *
 * Used to grey out the choices that cannot work, which is an input affordance
 * rather than a validation gate — the API checks cycles across the whole graph,
 * including the cross-job edges this editor never shows, and remains the
 * authority on whether a save is allowed.
 */
export function wouldCreateCycle(
    nodes: readonly PrecedenceNode[],
    operationId: string,
    candidate: string,
): boolean {
    if (candidate === operationId) return true;
    // A cycle appears exactly when the candidate already depends on this one.
    return ancestorsOf(nodes, candidate).has(operationId);
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

/**
 * How long the job takes if every independent step runs at once.
 *
 * The longest path through the graph, weighted by each step's own duration —
 * which is the figure a branching job's "how long is this" question actually
 * has. It is still not a schedule: it assumes a free machine whenever a step is
 * ready, where the real answer depends on contention the engine resolves.
 *
 * Shares `levelsOf`'s cycle guard: a draft mid-edit is never allowed to loop,
 * and a visited node contributes nothing rather than recursing forever.
 */
export function criticalPathMins(
    nodes: readonly PrecedenceNode[],
    minsOf: (id: string) => number,
): number {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const finishes = new Map<string, number>();
    const visiting = new Set<string>();

    function finish(id: string): number {
        const cached = finishes.get(id);
        if (cached !== undefined) return cached;
        if (visiting.has(id)) return 0;
        visiting.add(id);
        const predecessors = byId.get(id)?.dependsOn ?? [];
        const ready = predecessors.length === 0 ? 0 : Math.max(...predecessors.map(finish));
        const value = ready + minsOf(id);
        visiting.delete(id);
        finishes.set(id, value);
        return value;
    }

    return nodes.length === 0 ? 0 : Math.max(...nodes.map((node) => finish(node.id)));
}

/**
 * Translate a draft's precedence onto the ids the API just assigned.
 *
 * A new operation has only a placeholder id until it is saved, so the graph
 * cannot be written until the definition is. Positions are assigned 1..N from
 * the array the definition was sent as, and the response comes back sorted by
 * position, so index is the reliable correspondence between the two — not the
 * placeholder id, which the server never saw.
 */
export function edgesForSavedOperations(
    draftOperations: readonly PrecedenceNode[],
    savedOperationIds: readonly string[],
): DependencyEdge[] {
    const savedIdFor = new Map<string, string>();
    draftOperations.forEach((operation, index) => {
        const savedId = savedOperationIds[index];
        if (savedId !== undefined) savedIdFor.set(operation.id, savedId);
    });

    return draftOperations.flatMap((operation) => {
        const after = savedIdFor.get(operation.id);
        if (after === undefined) return [];
        return operation.dependsOn.flatMap((dependency) => {
            const before = savedIdFor.get(dependency);
            return before === undefined ? [] : [{ before_operation_id: before, after_operation_id: after }];
        });
    });
}
