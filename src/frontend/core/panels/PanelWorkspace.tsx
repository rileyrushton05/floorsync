"use client";

import {
    DndContext,
    DragOverlay,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type Announcements,
    type Collision,
    type DragEndEvent,
    type DragMoveEvent,
    type DragStartEvent,
    type ScreenReaderInstructions,
} from "@dnd-kit/core";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { cn } from "cn";
import {
    createContext,
    Fragment,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { PanelContext, type PanelMode, type PanelState } from "./context";
import { DropTargets, panelCollisions, panelKeyboardCoordinates, type ZoneFilter } from "./dnd";
import { movePanel, panelIds, project, type DropZone, type RenderNode } from "./layout";
import { GripIcon, PanelGrip } from "./PanelChrome";
import { panelMinimum, panelTitle, type Workspace } from "./workspace";

/** Matches Tailwind's `xl`: below it, panels stack and stay put. */
const WIDE_QUERY = "(min-width: 80rem)";
/** Width of the gap between split panels, which is also the resize handle. */
const SEPARATOR = 16;
/** How long panels take to glide into a new arrangement. */
const GLIDE_MS = 260;

type Placement = "stacked" | "tiled" | "maximised";

/* A panel's host is the element its content is portalled into. It is moved
   between slots rather than re-rendered, so a panel keeps its state (inputs,
   zoom, selection) wherever it goes. In a fixed-size slot the card fills it and
   its content scrolls; in the stacked column it takes its natural height. */
const HOST_BASE = "@container/panel relative flex min-w-0 flex-col";
const HOST_FILL = cn(
    HOST_BASE,
    "h-full min-h-0",
    "[&>[data-slot=card]]:min-h-0 [&>[data-slot=card]]:flex-1",
    "[&>[data-slot=card]>[data-slot=card-content]]:max-h-none [&>[data-slot=card]>[data-slot=card-content]]:min-h-0 [&>[data-slot=card]>[data-slot=card-content]]:flex-1 [&>[data-slot=card]>[data-slot=card-content]]:overflow-auto",
    // The content scrolls as a whole: nothing in it (a chart with its own
    // scroll box, say) is squeezed to fit the panel instead.
    "[&>[data-slot=card]>[data-slot=card-content]>*]:shrink-0",
);
// Cards have no fill of their own (they show the page through), so a panel
// over other panels brings the page background with it.
const HOST_CLASS: Record<Placement, string> = {
    stacked: HOST_BASE,
    tiled: HOST_FILL,
    maximised: cn(HOST_FILL, "rounded-lg bg-bg"),
};

interface Internals {
    workspace: Workspace;
    hostFor: (id: string) => HTMLDivElement | null;
    place: (id: string, slot: HTMLElement, placement: Placement) => void;
    register: (id: string) => () => void;
    panelState: (id: string) => PanelState;
}

const InternalsContext = createContext<Internals | null>(null);

function useInternals(): Internals {
    const internals = useContext(InternalsContext);
    if (!internals) throw new Error("Panel workspace parts must be inside a PanelWorkspace.");
    return internals;
}

function subscribeWide(onChange: () => void) {
    const query = window.matchMedia(WIDE_QUERY);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
}

function useWide(): boolean {
    return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => false);
}

function prefersReducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Snapshot {
    at: number;
    rects: Map<string, DOMRect>;
    dummy: DOMRect | null;
    focus: HTMLElement | null;
}

type Scrolls = Array<[Element, number, number]>;

/** A capture no change followed (say, maximising what already was) is
    dropped rather than replayed against a later change. */
const SNAPSHOT_TTL_MS = 500;

/** The dashed box standing in for a dragged panel where it would land. */
const DUMMY_SELECTOR = "[data-panel-dummy]";

function glide(element: Element, from: DOMRect) {
    element.getAnimations().forEach((animation) => animation.cancel());
    const to = element.getBoundingClientRect();
    if (from.width === 0 || from.height === 0 || to.width === 0 || to.height === 0) return;
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
    element.animate(
        [
            { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
            { transformOrigin: "top left", transform: "none" },
        ],
        { duration: GLIDE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
}

/**
 * Glides panels (and the dummy box of a panel being dragged) from where they
 * were to where they land (FLIP), and puts back what moving an element in the
 * DOM loses: scroll positions and focus. Call `capture` before a change and
 * `play` once it has been drawn.
 *
 * Scroll positions are remembered per panel from its last capture, so one
 * that was out of the layout for a while (being dragged, or hidden) comes back
 * scrolled where it was. Focus is put back only for someone using the
 * keyboard: after a click, focusing the moved button would read as keyboard
 * focus and pop its tooltip, which would then take the next Escape.
 */
function useGlide(hosts: React.RefObject<Map<string, HTMLDivElement>>, area: React.RefObject<HTMLDivElement | null>) {
    const pending = useRef<Snapshot | null>(null);
    const scrolls = useRef(new Map<string, Scrolls>());
    const usingKeyboard = useRef(false);

    useEffect(() => {
        const onKey = () => {
            usingKeyboard.current = true;
        };
        const onPointer = () => {
            usingKeyboard.current = false;
        };
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("pointerdown", onPointer, true);
        return () => {
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("pointerdown", onPointer, true);
        };
    }, []);

    const capture = useCallback(() => {
        // Several changes in one event glide from where things were before the first.
        if (pending.current && performance.now() - pending.current.at < SNAPSHOT_TTL_MS) return;
        const rects = new Map<string, DOMRect>();
        let focus: HTMLElement | null = null;
        hosts.current.forEach((host, id) => {
            if (!host.isConnected) return;
            rects.set(id, host.getBoundingClientRect());
            const kept: Scrolls = [];
            host.querySelectorAll("*").forEach((element) => {
                if (element.scrollTop || element.scrollLeft) kept.push([element, element.scrollTop, element.scrollLeft]);
            });
            scrolls.current.set(id, kept);
            if (usingKeyboard.current && host.contains(document.activeElement)) focus = document.activeElement as HTMLElement;
        });
        const dummy = area.current?.querySelector(DUMMY_SELECTOR)?.getBoundingClientRect() ?? null;
        pending.current = { at: performance.now(), rects, dummy, focus };
    }, [hosts, area]);

    const play = useCallback(() => {
        const snapshot = pending.current;
        pending.current = null;
        if (!snapshot || performance.now() - snapshot.at > SNAPSHOT_TTL_MS) return;
        scrolls.current.forEach((kept, id) => {
            if (!hosts.current.get(id)?.isConnected) return;
            for (const [element, top, left] of kept) element.scrollTo({ top, left, behavior: "instant" });
        });
        const focus = snapshot.focus as HTMLElement | null;
        if (focus?.isConnected && (document.activeElement === document.body || document.activeElement === null)) {
            focus.focus({ preventScroll: true });
        }
        if (prefersReducedMotion()) return;
        // The next frame, before it paints: by then the splits have settled.
        requestAnimationFrame(() => {
            hosts.current.forEach((host, id) => {
                const from = snapshot.rects.get(id);
                if (from && host.isConnected) glide(host, from);
            });
            const dummy = area.current?.querySelector(DUMMY_SELECTOR);
            if (dummy && snapshot.dummy) glide(dummy, snapshot.dummy);
        });
    }, [hosts, area]);

    return { capture, play };
}

interface DropTarget {
    id: string;
    zone: DropZone;
}

interface DragState {
    id: string;
    target: DropTarget | null;
}

function dropTarget(collisions: Collision[] | null): DropTarget | null {
    const first = collisions?.[0];
    const zone = first?.data?.zone as DropZone | undefined;
    return first && zone ? { id: String(first.id), zone } : null;
}

const POINTER_OPTIONS = { activationConstraint: { distance: 4 } };

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
    draggable:
        "To move this panel, press Space or Enter. Then use the arrow keys to choose where it goes — beside another panel, or in its place — and press Space or Enter to drop it, or Escape to leave it where it was.",
};

/**
 * Lays out a screen's panels. From `xl` up they fill the space under the
 * topbar as a split layout: drag a panel's grip onto an edge of another panel
 * to put it beside that one, or onto its middle to swap the two; drag the gaps
 * to resize. Panels can also fill the layout (maximise), or be hidden and
 * brought back from the topbar's Panels menu. Below `xl` they stack
 * in a single column in layout order and do not move.
 *
 * Each panel is a `WorkspacePanel` child naming one of the workspace's panels.
 * A panel that is not rendered (say, waiting on data) leaves the layout until
 * it is, then returns to the same place.
 */
export function PanelWorkspace({
    workspace,
    notice,
    children,
}: {
    workspace: Workspace;
    /** Shown above the panels, for something about the whole page (a failed
        refresh, say) rather than one panel. */
    notice?: React.ReactNode;
    children: React.ReactNode;
}) {
    const { definition, layout, maximised } = workspace;
    const wide = useWide();
    const hosts = useRef(new Map<string, HTMLDivElement>());
    const areaRef = useRef<HTMLDivElement>(null);
    const [available, setAvailable] = useState<ReadonlySet<string>>(() => new Set());
    const [drag, setDrag] = useState<DragState | null>(null);
    const [dropTargets] = useState(() => new DropTargets());
    const { capture, play } = useGlide(hosts, areaRef);

    const { onBeforeChange } = workspace;
    useLayoutEffect(() => onBeforeChange(capture), [onBeforeChange, capture]);

    const hidden = useMemo(() => new Set(layout.hidden), [layout.hidden]);
    const onShow = useCallback((id: string) => available.has(id) && !hidden.has(id), [available, hidden]);
    const tree = useMemo(() => project(layout.root, onShow), [layout.root, onShow]);
    const tiled = useMemo(() => (tree ? renderIds(tree) : []), [tree]);
    // While dragging, the split layout is drawn as it will be if the panel is
    // dropped now — the dragged panel a dashed dummy box where it would land.
    // With no target that is where it started.
    const dragId = drag?.id ?? null;
    const targetId = drag?.target?.id ?? null;
    const targetZone = drag?.target?.zone ?? null;
    const drawn = useMemo(() => {
        if (dragId === null || targetId === null || targetZone === null) return tree;
        return project(movePanel(layout.root, dragId, targetId, targetZone), onShow);
    }, [dragId, targetId, targetZone, tree, layout.root, onShow]);
    const maximisedId = wide && maximised !== null && onShow(maximised) ? maximised : null;
    const stacked = useMemo(() => panelIds(layout.root).filter(onShow), [layout.root, onShow]);

    // Once a change is drawn, put back scroll and focus and glide panels into
    // place. Keyed on what moves panels, so a capture made while a panel
    // registers waits for the render that brings it in.
    useLayoutEffect(() => {
        play();
    }, [play, layout, available, maximisedId, wide, workspace.revision, drawn]);

    // Escape restores a maximised panel unless something inside it (a menu,
    // a search field) used the key first. Listened for on the document: panel
    // content is portalled, so its React events never pass through the
    // overlay it sits in.
    const { setMaximised } = workspace;
    useEffect(() => {
        if (!maximisedId) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            setMaximised(null);
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [maximisedId, setMaximised]);

    const minimum = useCallback((id: string) => panelMinimum(definition, id), [definition]);
    const title = useCallback((id: string) => panelTitle(definition, id), [definition]);

    const canSplit: ZoneFilter = useCallback(
        (panelId, targetId, zone, rect) => {
            const moving = minimum(panelId);
            const staying = minimum(targetId);
            return zone === "left" || zone === "right"
                ? rect.width >= moving.width + staying.width + SEPARATOR
                : rect.height >= moving.height + staying.height + SEPARATOR;
        },
        [minimum],
    );

    const modeOf = useCallback(
        (id: string): PanelMode => {
            if (!wide) return "stacked";
            return maximisedId === id ? "maximised" : "tiled";
        },
        [wide, maximisedId],
    );

    const panelState = useCallback(
        (id: string): PanelState => {
            const mode = modeOf(id);
            return {
                id,
                title: title(id),
                mode,
                targets: tiled.filter((other) => other !== id).map((other) => ({ id: other, title: title(other) })),
                canMoveBeside: (targetId, zone) => {
                    const rect = hosts.current.get(targetId)?.getBoundingClientRect();
                    return rect ? canSplit(id, targetId, zone, rect) : false;
                },
                move: (targetId, zone) => workspace.move(id, targetId, zone),
                toggleMaximised: () => workspace.setMaximised(mode === "maximised" ? null : id),
                hide: () => workspace.setHidden(id, true),
            };
        },
        [modeOf, title, tiled, canSplit, workspace],
    );

    // Stable for the workspace's life: a panel registers once, however often
    // the layout around it changes.
    const hostFor = useCallback((id: string) => {
        if (typeof document === "undefined") return null;
        let host = hosts.current.get(id);
        if (!host) {
            host = document.createElement("div");
            host.dataset.panelHost = id;
            hosts.current.set(id, host);
        }
        return host;
    }, []);
    const place = useCallback((id: string, slot: HTMLElement, placement: Placement) => {
        const host = hosts.current.get(id);
        if (!host) return;
        if (host.className !== HOST_CLASS[placement]) host.className = HOST_CLASS[placement];
        if (host.parentElement !== slot) slot.appendChild(host);
    }, []);
    const register = useCallback(
        (id: string) => {
            capture();
            setAvailable((previous) => (previous.has(id) ? previous : new Set(previous).add(id)));
            return () => {
                capture();
                setAvailable((previous) => {
                    if (!previous.has(id)) return previous;
                    const next = new Set(previous);
                    next.delete(id);
                    return next;
                });
            };
        },
        [capture],
    );

    const internals = useMemo<Internals>(
        () => ({ workspace, hostFor, place, register, panelState }),
        [workspace, hostFor, place, register, panelState],
    );

    const keyboardOptions = useMemo(
        () => ({ coordinateGetter: panelKeyboardCoordinates(canSplit, dropTargets) }),
        [canSplit, dropTargets],
    );
    const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS), useSensor(KeyboardSensor, keyboardOptions));
    const collisionDetection = useMemo(() => panelCollisions(canSplit, dropTargets), [canSplit, dropTargets]);

    /** Where a drop on `target` puts the dragged panel, as a phrase: "to the
        left of Plan", "in place of Plan". */
    const destination = useCallback(
        (target: DropTarget) => {
            const other = title(target.id);
            switch (target.zone) {
                case "center":
                    return `in place of ${other}, which takes its spot`;
                case "left":
                    return `to the left of ${other}`;
                case "right":
                    return `to the right of ${other}`;
                case "top":
                    return `above ${other}`;
                case "bottom":
                    return `below ${other}`;
            }
        },
        [title],
    );

    // The drag handlers run before the announcements, which read the target
    // they have just worked out. Moving within one zone stays quiet.
    const dragRef = useRef<DragState | null>(null);
    const droppedOn = useRef<DropTarget | null>(null);
    const lastSpoken = useRef<string | null>(null);
    const announcements: Announcements = useMemo(
        () => ({
            onDragStart: ({ active }) => {
                lastSpoken.current = null;
                return `Picked up ${title(String(active.id))}.`;
            },
            onDragMove: ({ active }) => {
                const target = dragRef.current?.target ?? null;
                const message = target
                    ? `Drop to put ${title(String(active.id))} ${destination(target)}.`
                    : `${title(String(active.id))} is not over a panel.`;
                if (message === lastSpoken.current) return undefined;
                lastSpoken.current = message;
                return message;
            },
            onDragOver: () => undefined,
            onDragEnd: ({ active }) => {
                const target = droppedOn.current;
                return target
                    ? `Moved ${title(String(active.id))} ${destination(target)}.`
                    : `${title(String(active.id))} stayed where it was.`;
            },
            onDragCancel: ({ active }) => `Cancelled. ${title(String(active.id))} stayed where it was.`,
        }),
        [destination, title],
    );

    const setDragState = (next: DragState | null) => {
        dragRef.current = next;
        setDrag(next);
    };

    const onDragStart = ({ active }: DragStartEvent) => {
        const id = String(active.id);
        dropTargets.set(
            new Map(
                tiled.flatMap((other) => {
                    const host = hosts.current.get(other);
                    return other !== id && host?.isConnected ? [[other, host.getBoundingClientRect()] as const] : [];
                }),
            ),
        );
        capture();
        setDragState({ id, target: null });
    };

    const onDragMove = ({ collisions }: DragMoveEvent) => {
        const current = dragRef.current;
        if (!current) return;
        const target = dropTarget(collisions);
        if (target?.id === current.target?.id && target?.zone === current.target?.zone) return;
        // The layout is about to show a different drop: glide into it.
        capture();
        setDragState({ ...current, target });
    };

    const endDrag = (event: DragEndEvent | null) => {
        const current = dragRef.current;
        // The dragged panel drops straight into the dummy's place (it is out
        // of the layout, so nothing to glide); the rest glide from the preview,
        // or back if nothing changes.
        capture();
        setDragState(null);
        if (!current) return;
        const target = event ? current.target : null;
        droppedOn.current = target;
        if (target) workspace.move(current.id, target.id, target.zone);
    };

    return (
        <InternalsContext.Provider value={internals}>
            <DndContext
                sensors={sensors}
                collisionDetection={collisionDetection}
                autoScroll={false}
                accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
                onDragStart={onDragStart}
                onDragMove={onDragMove}
                onDragEnd={endDrag}
                onDragCancel={() => endDrag(null)}
            >
                {wide ? (
                    <main className="flex min-h-0 flex-1 flex-col gap-4 p-5">
                        {notice}
                        <div ref={areaRef} className={cn("relative min-h-0 flex-1", drag && "select-none")}>
                            {drawn ? (
                                <Tiles key={workspace.revision} node={drawn} maximisedId={maximisedId} dummyId={dragId} />
                            ) : (
                                <EmptyWorkspace onReset={workspace.reset} />
                            )}

                            {maximisedId && (
                                <div className="absolute inset-0 z-50">
                                    <HostSlot id={maximisedId} placement="maximised" className="h-full w-full" />
                                </div>
                            )}
                        </div>
                    </main>
                ) : (
                    <main className="flex flex-1 flex-col gap-3 p-3 sm:gap-5 sm:p-5">
                        {notice}
                        {stacked.map((id) => (
                            <HostSlot key={id} id={id} placement="stacked" className="flex min-w-0 flex-col" />
                        ))}
                    </main>
                )}

                {typeof document !== "undefined" &&
                    createPortal(
                        <DragOverlay dropAnimation={null} zIndex={80}>
                            {drag ? <DragGhost title={title(drag.id)} /> : null}
                        </DragOverlay>,
                        document.body,
                    )}
                {children}
            </DndContext>
        </InternalsContext.Provider>
    );
}

/**
 * One of a workspace's panels: its content (normally a single `Card`) and the
 * grip it is moved by. Put `PanelControls` in the card's header for its
 * maximise, hide and move controls.
 */
export function WorkspacePanel({ id, children }: { id: string; children: React.ReactNode }) {
    const internals = useInternals();
    const [host] = useState(() => internals.hostFor(id));
    const { register } = internals;

    useLayoutEffect(() => register(id), [register, id]);

    if (!host) return null;
    const panel = internals.panelState(id);
    return createPortal(
        <PanelContext.Provider value={panel}>
            <PanelGrip panel={panel} />
            {children}
        </PanelContext.Provider>,
        host,
    );
}

function renderIds(node: RenderNode): string[] {
    return node.kind === "panel" ? [node.id] : node.children.flatMap(renderIds);
}

/** The element a panel's host is placed in. */
function HostSlot({ id, placement, className }: { id: string; placement: Placement; className?: string }) {
    const { place } = useInternals();
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (ref.current) place(id, ref.current, placement);
    });
    return <div ref={ref} className={className} />;
}

function nodeKey(node: RenderNode): string {
    return node.kind === "panel" ? `p:${node.id}` : `s:${node.id}`;
}

/** Smallest a drawn node can be along `direction`, so splits never squeeze
    a panel below its minimum. */
function minimumAlong(node: RenderNode, direction: "row" | "column", minimum: (id: string) => { width: number; height: number }): number {
    if (node.kind === "panel") return direction === "row" ? minimum(node.id).width : minimum(node.id).height;
    const sizes = node.children.map((child) => minimumAlong(child, direction, minimum));
    return node.direction === direction
        ? sizes.reduce((sum, size) => sum + size, 0) + SEPARATOR * (sizes.length - 1)
        : Math.max(...sizes);
}

interface TileProps {
    maximisedId: string | null;
    /** The panel being dragged, drawn as a dummy box where it would land. */
    dummyId: string | null;
}

function Tiles({ node, ...props }: TileProps & { node: RenderNode }) {
    if (node.kind === "panel") return <Tile id={node.id} {...props} />;
    // A split re-reads its sizes whenever its set of children changes.
    return <TileSplit key={node.children.map(nodeKey).join("|")} node={node} {...props} />;
}

function TileSplit({ node, ...props }: TileProps & { node: Extract<RenderNode, { kind: "split" }> }) {
    const { workspace } = useInternals();
    const horizontal = node.direction === "row";
    const keys = node.children.map(nodeKey);
    const [defaultLayout] = useState(() => Object.fromEntries(keys.map((key, index) => [key, node.sizes[index]])));
    const minimum = (id: string) => panelMinimum(workspace.definition, id);

    return (
        <Group
            orientation={horizontal ? "horizontal" : "vertical"}
            defaultLayout={defaultLayout}
            onLayoutChanged={(layout, meta) => {
                if (!meta.isUserInteraction) return;
                workspace.resize(node.id, node.slots, keys.map((key) => layout[key] ?? 0));
            }}
            className="h-full w-full"
        >
            {node.children.map((child, index) => (
                <Fragment key={keys[index]}>
                    {index > 0 && <SplitHandle horizontal={horizontal} />}
                    <Panel id={keys[index]} minSize={minimumAlong(child, node.direction, minimum)} style={{ overflow: "visible" }}>
                        <Tiles node={child} {...props} />
                    </Panel>
                </Fragment>
            ))}
        </Group>
    );
}

/** The gap between two split panels, which resizes them: drag it, or focus
    it and use the arrow keys; double-click returns the split to its default. */
function SplitHandle({ horizontal }: { horizontal: boolean }) {
    return (
        <Separator
            className={cn(
                "group/split relative flex shrink-0 items-center justify-center outline-hidden",
                horizontal ? "w-4" : "h-4",
            )}
        >
            <span
                aria-hidden
                className={cn(
                    "absolute rounded-full bg-transparent transition-colors duration-150 group-data-[separator=active]/split:bg-primary group-data-[separator=focus]/split:bg-primary group-data-[separator=hover]/split:bg-primary/50",
                    horizontal ? "inset-y-1 w-0.5" : "inset-x-1 h-0.5",
                )}
            />
            <span
                aria-hidden
                className={cn(
                    "relative rounded-full bg-border transition-colors duration-150 group-data-[separator=active]/split:bg-primary group-data-[separator=focus]/split:bg-primary group-data-[separator=hover]/split:bg-primary/70",
                    horizontal ? "h-8 w-1" : "h-1 w-8",
                )}
            />
        </Separator>
    );
}

function Tile({ id, maximisedId, dummyId }: TileProps & { id: string }) {
    if (id === dummyId) {
        return <div data-panel-dummy className="h-full w-full rounded-lg border-2 border-dashed border-primary/60 bg-primary/5" />;
    }
    if (id === maximisedId) {
        return <div className="h-full w-full rounded-lg border border-dashed" />;
    }
    return <HostSlot id={id} placement="tiled" className="h-full w-full" />;
}

function DragGhost({ title }: { title: string }) {
    return (
        <div className="flex w-max max-w-72 cursor-grabbing items-center gap-2 rounded-lg border bg-overlay px-3 py-2 font-semibold text-overlay-fg text-sm shadow-xl ring-1 ring-primary/30 animate-in zoom-in-95 fade-in">
            <GripIcon className="text-muted-fg" />
            <span className="truncate">{title}</span>
        </div>
    );
}

function EmptyWorkspace({ onReset }: { onReset: () => void }) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center">
            <p className="font-semibold">No panels in the layout</p>
            <p className="max-w-sm text-muted-fg text-sm">
                Every panel is hidden. Bring one back from the Panels menu, or reset the layout.
            </p>
            <Button intent="outline" size="sm" onPress={onReset}>
                <ArrowPathIcon /> Reset layout
            </Button>
        </div>
    );
}
