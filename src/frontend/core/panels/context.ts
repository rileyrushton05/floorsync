"use client";

import { createContext, useContext } from "react";
import type { DropZone } from "./layout";

/** How a panel is shown: in the stacked column below `xl`, in the split
    layout, or filling the workspace. */
export type PanelMode = "stacked" | "tiled" | "maximised";

export interface PanelState {
    id: string;
    title: string;
    mode: PanelMode;
    /** The other panels in the split layout, which this one can swap with or
        move beside. */
    targets: Array<{ id: string; title: string }>;
    /** Whether moving beside `targetId` on that side leaves both panels at
        least their minimum size. */
    canMoveBeside: (targetId: string, zone: Exclude<DropZone, "center">) => boolean;
    move: (targetId: string, zone: DropZone) => void;
    toggleMaximised: () => void;
    hide: () => void;
}

export const PanelContext = createContext<PanelState | null>(null);

/** The panel this component is drawn in, or null outside a workspace. */
export function usePanel(): PanelState | null {
    return useContext(PanelContext);
}
