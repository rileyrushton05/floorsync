"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePersistentString } from "@/core/shell/usePersistentFlag";
import {
    movePanel,
    panelIds,
    parseLayout,
    setDrawnSizes,
    type DropZone,
    type LayoutNode,
    type WorkspaceLayout,
} from "./layout";

export interface PanelDefinition {
    /** Names the panel in menus, announcements and its controls. */
    title: string;
    /** Narrowest the panel gets beside another, in px. */
    minWidth?: number;
    /** Shortest the panel gets above or below another, in px. */
    minHeight?: number;
}

export interface WorkspaceDefinition {
    /** Names the screen's saved layout in this browser. */
    id: string;
    panels: Readonly<Record<string, PanelDefinition>>;
    /** The arrangement a screen starts with, and returns to on reset. */
    layout: LayoutNode;
}

const DEFAULT_MIN_WIDTH = 240;
const DEFAULT_MIN_HEIGHT = 140;

/** Declares a screen's panels and default arrangement. The arrangement must
    place every declared panel exactly once. */
export function defineWorkspace(definition: WorkspaceDefinition): WorkspaceDefinition {
    const placed = panelIds(definition.layout);
    const declared = Object.keys(definition.panels);
    if (placed.length !== declared.length || !declared.every((id) => placed.includes(id))) {
        throw new Error(`Workspace "${definition.id}" must place each of its panels exactly once.`);
    }
    return definition;
}

export function panelMinimum(definition: WorkspaceDefinition, id: string): { width: number; height: number } {
    const panel = definition.panels[id];
    return { width: panel?.minWidth ?? DEFAULT_MIN_WIDTH, height: panel?.minHeight ?? DEFAULT_MIN_HEIGHT };
}

export function panelTitle(definition: WorkspaceDefinition, id: string): string {
    return definition.panels[id]?.title ?? id;
}

export interface Workspace {
    definition: WorkspaceDefinition;
    layout: WorkspaceLayout;
    /** The panel filling the workspace, if any. Not remembered across visits. */
    maximised: string | null;
    /** Nothing has been rearranged since the default (or the last reset). */
    isDefault: boolean;
    /** Bumped by every change except a resize, which the split already shows;
        splits re-read their sizes when it moves. */
    revision: number;
    move: (panelId: string, targetId: string, zone: DropZone) => void;
    setHidden: (panelId: string, hidden: boolean) => void;
    setMaximised: (panelId: string | null) => void;
    resize: (splitId: string, slots: number[], sizes: number[]) => void;
    reset: () => void;
    /** Has `listener` called just before any change that moves panels, so the
        workspace can animate them from where they were. Returns the undo. */
    onBeforeChange: (listener: () => void) => () => void;
}

/**
 * A screen's panel arrangement, remembered in this browser under
 * `floorsync.workspace.<id>`. A stored arrangement that no longer matches the
 * screen's panels is ignored in favour of the default.
 */
export function usePanelWorkspace(definition: WorkspaceDefinition): Workspace {
    const [raw, setRaw] = usePersistentString(`floorsync.workspace.${definition.id}`);
    const [maximised, setMaximisedState] = useState<string | null>(null);
    const [revision, setRevision] = useState(0);
    const beforeChange = useRef<(() => void) | null>(null);

    const fallback = useMemo<WorkspaceLayout>(
        () => ({ root: definition.layout, hidden: [] }),
        [definition],
    );
    const layout = useMemo<WorkspaceLayout>(() => {
        if (raw === null) return fallback;
        try {
            return parseLayout(JSON.parse(raw), Object.keys(definition.panels)) ?? fallback;
        } catch {
            return fallback;
        }
    }, [raw, definition, fallback]);

    // Actions read the latest layout, not the one they closed over, so two
    // changes in one event build on each other.
    const current = useRef(layout);
    useLayoutEffect(() => {
        current.current = layout;
    }, [layout]);

    const commit = useCallback(
        (next: WorkspaceLayout, { animate = true }: { animate?: boolean } = {}) => {
            if (animate) {
                beforeChange.current?.();
                setRevision((value) => value + 1);
            }
            current.current = next;
            setRaw(JSON.stringify(next));
        },
        [setRaw],
    );

    const move = useCallback(
        (panelId: string, targetId: string, zone: DropZone) => {
            const { root, hidden } = current.current;
            commit({ root: movePanel(root, panelId, targetId, zone), hidden });
        },
        [commit],
    );

    const setHidden = useCallback(
        (panelId: string, hide: boolean) => {
            const { hidden } = current.current;
            if (hidden.includes(panelId) === hide) return;
            if (hide) setMaximisedState((value) => (value === panelId ? null : value));
            commit({
                ...current.current,
                hidden: hide ? [...hidden, panelId] : hidden.filter((id) => id !== panelId),
            });
        },
        [commit],
    );

    const setMaximised = useCallback((panelId: string | null) => {
        beforeChange.current?.();
        setMaximisedState(panelId);
    }, []);

    const resize = useCallback(
        (splitId: string, slots: number[], sizes: number[]) => {
            commit({ ...current.current, root: setDrawnSizes(current.current.root, splitId, slots, sizes) }, { animate: false });
        },
        [commit],
    );

    const reset = useCallback(() => {
        beforeChange.current?.();
        setRevision((value) => value + 1);
        setMaximisedState(null);
        current.current = fallback;
        setRaw(null);
    }, [fallback, setRaw]);

    const onBeforeChange = useCallback((listener: () => void) => {
        beforeChange.current = listener;
        return () => {
            if (beforeChange.current === listener) beforeChange.current = null;
        };
    }, []);

    return useMemo(
        () => ({
            definition,
            layout,
            maximised,
            isDefault: raw === null,
            revision,
            move,
            setHidden,
            setMaximised,
            resize,
            reset,
            onBeforeChange,
        }),
        [definition, layout, maximised, raw, revision, move, setHidden, setMaximised, resize, reset, onBeforeChange],
    );
}
