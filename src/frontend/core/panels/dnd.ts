import type { ClientRect, CollisionDetection, KeyboardCoordinateGetter } from "@dnd-kit/core";
import type { DropZone } from "./layout";

interface Point {
    x: number;
    y: number;
}

/** Whether `panelId` may be dropped on `zone` of `targetId`, whose drawn
    box is `rect`; the centre (a swap) is always allowed. */
export type ZoneFilter = (panelId: string, targetId: string, zone: Exclude<DropZone, "center">, rect: ClientRect) => boolean;

/**
 * Where each panel a drag can land on was when the drag began. While a drag is
 * under way the layout previews the drop, so aiming against the moving preview
 * would pull the target out from under the pointer. Set when a drag starts;
 * read by the collision check and by the keyboard sensor, which is built
 * before the drag starts.
 */
export class DropTargets {
    private rects: ReadonlyMap<string, ClientRect> = new Map();

    set(rects: ReadonlyMap<string, ClientRect>) {
        this.rects = rects;
    }

    get(): ReadonlyMap<string, ClientRect> {
        return this.rects;
    }
}

export const DROP_ZONES: readonly DropZone[] = ["left", "right", "top", "bottom", "center"];

/** The middle of a panel, as a share of each side, that swaps rather than splits. */
const CENTRE_FROM = 0.3;
const CENTRE_TO = 0.7;
/** How far in from an edge the keyboard puts the drop point for that edge. */
const EDGE_ANCHOR = 0.12;

export function centreOf(rect: ClientRect): Point {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function contains(rect: ClientRect, point: Point): boolean {
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

/** The zone of `rect` under `point`: the middle swaps, otherwise the nearest
    edge — so a corner belongs to whichever edge it is closer to. An edge that
    is not allowed falls back to the middle. */
export function zoneAt(rect: ClientRect, point: Point, allowed: (zone: Exclude<DropZone, "center">) => boolean): DropZone {
    const x = (point.x - rect.left) / rect.width;
    const y = (point.y - rect.top) / rect.height;
    if (x >= CENTRE_FROM && x <= CENTRE_TO && y >= CENTRE_FROM && y <= CENTRE_TO) return "center";
    const edges: Array<[Exclude<DropZone, "center">, number]> = [
        ["left", x],
        ["right", 1 - x],
        ["top", y],
        ["bottom", 1 - y],
    ];
    edges.sort((a, b) => a[1] - b[1]);
    const nearest = edges[0][0];
    return allowed(nearest) ? nearest : "center";
}

/** Where the keyboard puts the drop point to aim at `zone`; `zoneAt` reads
    it back as that same zone. */
function zoneAnchor(rect: ClientRect, zone: DropZone): Point {
    const { x, y } = centreOf(rect);
    switch (zone) {
        case "left":
            return { x: rect.left + rect.width * EDGE_ANCHOR, y };
        case "right":
            return { x: rect.right - rect.width * EDGE_ANCHOR, y };
        case "top":
            return { x, y: rect.top + rect.height * EDGE_ANCHOR };
        case "bottom":
            return { x, y: rect.bottom - rect.height * EDGE_ANCHOR };
        case "center":
            return { x, y };
    }
}

/**
 * Finds the panel under the drop point and which of its zones that point is
 * in, against where the panels were when the drag began. The drop point is
 * the pointer, or — when moving with the keyboard, which has no pointer — the
 * middle of the dragged item. The zone rides on the collision as `data.zone`.
 */
export function panelCollisions(allowed: ZoneFilter, targets: DropTargets): CollisionDetection {
    return ({ active, collisionRect, pointerCoordinates }) => {
        const point = pointerCoordinates ?? centreOf(collisionRect);
        for (const [id, rect] of targets.get()) {
            if (id === active.id || !contains(rect, point)) continue;
            const zone = zoneAt(rect, point, (edge) => allowed(String(active.id), id, edge, rect));
            return [{ id, data: { zone } }];
        }
        return [];
    };
}

const ARROWS: Record<string, Point> = {
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
};

/**
 * Moves a keyboard drag from one drop zone to the next in the arrow's
 * direction, across every panel's allowed zones: the nearest one that way,
 * favouring those in line with where the drag is now.
 */
export function panelKeyboardCoordinates(allowed: ZoneFilter, targets: DropTargets): KeyboardCoordinateGetter {
    return (event, { active, context }) => {
        const step = ARROWS[event.code];
        const rect = context.collisionRect;
        if (!step || !rect) return undefined;
        event.preventDefault();

        const from = centreOf(rect);
        let best: Point | null = null;
        let bestScore = Infinity;
        for (const [id, target] of targets.get()) {
            if (id === active) continue;
            for (const zone of DROP_ZONES) {
                if (zone !== "center" && !allowed(String(active), String(id), zone, target)) continue;
                const anchor = zoneAnchor(target, zone);
                const along = (anchor.x - from.x) * step.x + (anchor.y - from.y) * step.y;
                if (along <= 1) continue;
                const across = Math.abs((anchor.x - from.x) * step.y) + Math.abs((anchor.y - from.y) * step.x);
                const score = along + across * 2;
                if (score < bestScore) {
                    best = anchor;
                    bestScore = score;
                }
            }
        }
        if (!best) return undefined;
        return { x: best.x - rect.width / 2, y: best.y - rect.height / 2 };
    };
}
