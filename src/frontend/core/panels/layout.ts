/**
 * The arrangement of a panel workspace, as plain data: a tree of splits whose
 * leaves are panels, plus which panels are hidden. Every change is
 * a pure function from one layout to the next, so the workspace can persist,
 * validate and animate between them without the tree knowing about React.
 *
 * Split sizes are percentages of their split (summing to 100). A panel that
 * is hidden or not available right now keeps its leaf, so it
 * returns to the same spot; the rendered tree is a projection that leaves it
 * out.
 */

export type Direction = "row" | "column";

/** Where a dragged panel lands on the panel it is dropped on: one of its
    edges (splitting that panel) or its centre (swapping the two). */
export type DropZone = "left" | "right" | "top" | "bottom" | "center";

export interface PanelLeaf {
    kind: "panel";
    id: string;
}

export interface SplitNode {
    kind: "split";
    id: string;
    direction: Direction;
    children: LayoutNode[];
    sizes: number[];
}

export type LayoutNode = PanelLeaf | SplitNode;

export interface WorkspaceLayout {
    root: LayoutNode;
    hidden: string[];
}

/** The tree as drawn: only the panels on show, with each split's sizes
    rescaled over the children it still has. `slots` maps every drawn child
    back to its index in the stored split, so a resize can be written back. */
export type RenderNode =
    | { kind: "panel"; id: string }
    | { kind: "split"; id: string; direction: Direction; children: RenderNode[]; sizes: number[]; slots: number[] };

let splitCounter = 0;

function newSplitId(): string {
    splitCounter += 1;
    return `s${Date.now().toString(36)}${splitCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ----- Building default layouts ----- */

type Child = string | LayoutNode;

function toNode(child: Child): LayoutNode {
    return typeof child === "string" ? { kind: "panel", id: child } : child;
}

function split(direction: Direction, children: Array<[Child, number]>): SplitNode {
    return normalizeSplit({
        kind: "split",
        id: newSplitId(),
        direction,
        children: children.map(([child]) => toNode(child)),
        sizes: children.map(([, size]) => size),
    });
}

/** Children side by side, each with its share of the width in percent. */
export function row(...children: Array<[Child, number]>): SplitNode {
    return split("row", children);
}

/** Children stacked top to bottom, each with its share of the height in percent. */
export function column(...children: Array<[Child, number]>): SplitNode {
    return split("column", children);
}

/* ----- Reading ----- */

/** Every panel id in reading order: left to right, top to bottom. */
export function panelIds(node: LayoutNode): string[] {
    return node.kind === "panel" ? [node.id] : node.children.flatMap(panelIds);
}

export function findSplit(node: LayoutNode, splitId: string): SplitNode | null {
    if (node.kind === "panel") return null;
    if (node.id === splitId) return node;
    for (const child of node.children) {
        const found = findSplit(child, splitId);
        if (found) return found;
    }
    return null;
}

/** The drawn tree: panels for which `shown` is false drop out, splits left
    with one child give way to it, and splits left with none disappear. */
export function project(node: LayoutNode, shown: (id: string) => boolean): RenderNode | null {
    if (node.kind === "panel") return shown(node.id) ? node : null;
    const children: RenderNode[] = [];
    const sizes: number[] = [];
    const slots: number[] = [];
    node.children.forEach((child, index) => {
        const projected = project(child, shown);
        if (!projected) return;
        children.push(projected);
        sizes.push(node.sizes[index] ?? 0);
        slots.push(index);
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { kind: "split", id: node.id, direction: node.direction, children, sizes: toPercentages(sizes), slots };
}

/* ----- Changing ----- */

function toPercentages(sizes: number[]): number[] {
    const valid = sizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 0));
    const total = valid.reduce((sum, size) => sum + size, 0);
    if (total <= 0) return valid.map(() => 100 / valid.length);
    return valid.map((size) => (size / total) * 100);
}

/** Flattens a split: a child split running the same way merges into it
    (taking its share), a child split of one child gives way to that child,
    and sizes are rescaled to 100. */
function normalizeSplit(node: SplitNode): SplitNode {
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, index) => {
        const share = node.sizes[index] ?? 0;
        const normalized = child.kind === "split" ? normalize(child) : child;
        if (normalized.kind === "split" && normalized.direction === node.direction) {
            normalized.children.forEach((grandchild, inner) => {
                children.push(grandchild);
                sizes.push((share * (normalized.sizes[inner] ?? 0)) / 100);
            });
        } else {
            children.push(normalized);
            sizes.push(share);
        }
    });
    return { ...node, children, sizes: toPercentages(sizes) };
}

export function normalize(node: LayoutNode): LayoutNode {
    if (node.kind === "panel") return node;
    if (node.children.length === 1) return normalize(node.children[0]);
    return normalizeSplit(node);
}

/** The tree without `panelId`; its share goes to its siblings in proportion. */
export function removePanel(node: LayoutNode, panelId: string): LayoutNode | null {
    if (node.kind === "panel") return node.id === panelId ? null : node;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, index) => {
        const kept = removePanel(child, panelId);
        if (!kept) return;
        children.push(kept);
        sizes.push(node.sizes[index] ?? 0);
    });
    if (children.length === 0) return null;
    return normalize({ ...node, children, sizes });
}

/** Swaps two panels' places; each takes the other's size. */
export function swapPanels(node: LayoutNode, a: string, b: string): LayoutNode {
    if (node.kind === "panel") {
        if (node.id === a) return { kind: "panel", id: b };
        if (node.id === b) return { kind: "panel", id: a };
        return node;
    }
    return { ...node, children: node.children.map((child) => swapPanels(child, a, b)) };
}

/** Puts `panelId` (not already in the tree) on one edge of `targetId`, which
    gives up half its space. Joins the target's split when that runs the same
    way, otherwise turns the target into a new split of the two. */
function insertBeside(node: LayoutNode, targetId: string, panelId: string, zone: Exclude<DropZone, "center">): LayoutNode {
    const direction: Direction = zone === "left" || zone === "right" ? "row" : "column";
    const before = zone === "left" || zone === "top";
    const leaf: PanelLeaf = { kind: "panel", id: panelId };

    if (node.kind === "panel") {
        if (node.id !== targetId) return node;
        return {
            kind: "split",
            id: newSplitId(),
            direction,
            children: before ? [leaf, node] : [node, leaf],
            sizes: [50, 50],
        };
    }

    const index = node.children.findIndex((child) => child.kind === "panel" && child.id === targetId);
    if (index !== -1 && node.direction === direction) {
        const half = (node.sizes[index] ?? 0) / 2;
        const children = [...node.children];
        const sizes = [...node.sizes];
        sizes[index] = half;
        children.splice(before ? index : index + 1, 0, leaf);
        sizes.splice(before ? index : index + 1, 0, half);
        return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map((child) => insertBeside(child, targetId, panelId, zone)) };
}

/** Moves `panelId` onto `targetId`: the centre swaps them, an edge splits
    the target. Returns the layout unchanged if either is missing. */
export function movePanel(root: LayoutNode, panelId: string, targetId: string, zone: DropZone): LayoutNode {
    if (panelId === targetId) return root;
    const ids = panelIds(root);
    if (!ids.includes(panelId) || !ids.includes(targetId)) return root;
    if (zone === "center") return swapPanels(root, panelId, targetId);
    const without = removePanel(root, panelId);
    if (!without) return root;
    return normalize(insertBeside(without, targetId, panelId, zone));
}

/** Writes sizes from a drawn split (over its drawn children only) back into
    the stored split, keeping the shares of the children not on show. */
export function setDrawnSizes(node: LayoutNode, splitId: string, slots: number[], drawnSizes: number[]): LayoutNode {
    if (node.kind === "panel") return node;
    if (node.id !== splitId) {
        return { ...node, children: node.children.map((child) => setDrawnSizes(child, splitId, slots, drawnSizes)) };
    }
    const sizes = [...node.sizes];
    const total = slots.reduce((sum, slot) => sum + (sizes[slot] ?? 0), 0);
    slots.forEach((slot, index) => {
        sizes[slot] = ((drawnSizes[index] ?? 0) / 100) * total;
    });
    return { ...node, sizes: toPercentages(sizes) };
}

/* ----- Persistence ----- */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function parseNode(value: unknown, seenSplits: Set<string>): LayoutNode | null {
    if (!isRecord(value)) return null;
    if (value.kind === "panel") {
        return typeof value.id === "string" ? { kind: "panel", id: value.id } : null;
    }
    if (value.kind !== "split") return null;
    const { id, direction, children, sizes } = value;
    if (typeof id !== "string" || seenSplits.has(id)) return null;
    if (direction !== "row" && direction !== "column") return null;
    if (!Array.isArray(children) || !Array.isArray(sizes) || children.length < 2 || children.length !== sizes.length) return null;
    if (!sizes.every((size) => isFiniteNumber(size) && size > 0)) return null;
    seenSplits.add(id);
    const parsed: LayoutNode[] = [];
    for (const child of children) {
        const node = parseNode(child, seenSplits);
        if (!node) return null;
        parsed.push(node);
    }
    return { kind: "split", id, direction, children: parsed, sizes: toPercentages(sizes as number[]) };
}

/** A stored layout, if it is well formed and arranges exactly `expectedIds`
    (each once). Anything else — an older shape, a panel since added or
    removed — is refused, so the screen falls back to its default. */
export function parseLayout(value: unknown, expectedIds: readonly string[]): WorkspaceLayout | null {
    if (!isRecord(value)) return null;
    const root = parseNode(value.root, new Set());
    if (!root) return null;
    const ids = panelIds(root);
    const expected = new Set(expectedIds);
    if (ids.length !== expected.size || new Set(ids).size !== ids.length || !ids.every((id) => expected.has(id))) return null;

    const hidden = Array.isArray(value.hidden) ? value.hidden : [];
    if (!hidden.every((id): id is string => typeof id === "string" && expected.has(id))) return null;

    // Any other stored fields are ignored.
    return { root: normalize(root), hidden: [...new Set(hidden)] };
}
