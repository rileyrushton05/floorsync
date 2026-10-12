"use client";

import { EllipsisVerticalIcon } from "@heroicons/react/24/outline";
import { cn } from "cn";
import { useRef, useState } from "react";
import { usePersistentNumber } from "./usePersistentFlag";

type Side = "left" | "right";

/** The main column never gets squeezed narrower than this by a pane resize. */
const MAIN_MIN_WIDTH = 360;
/** How far one arrow-key press moves a resize handle. */
const KEY_STEP = 16;

/**
 * A page body made of side panes around a main column. From `xl` up the panes
 * sit beside the main column, sized by flex-grow ratios (the old
 * `minmax(min, Nfr)` grid columns) until someone drags them to a width; below
 * that everything stacks.
 */
export function SidePaneLayout({ className, children }: { className?: string; children: React.ReactNode }) {
    return <main className={cn("flex flex-1 flex-col gap-5 p-5 xl:flex-row", className)}>{children}</main>;
}

/** The main column of a `SidePaneLayout`; it takes the space panes leave. */
export function SidePaneMain({ grow, children }: { grow: number; children: React.ReactNode }) {
    return (
        <div
            className="flex min-w-0 flex-col *:flex-1 xl:flex-[var(--pane-grow)_1_0%]"
            style={{ "--pane-grow": grow } as React.CSSProperties}
        >
            {children}
        </div>
    );
}

/**
 * A side pane whose width can be dragged from `xl` up, by the handle on the
 * edge it shares with the main column (or with the arrow keys once that handle
 * has focus); hovering it says so. Double-clicking the handle returns it to
 * its default share.
 * Each pane remembers its width in this browser under `id`.
 */
export function SidePane({
    id,
    side,
    label,
    grow,
    minWidth,
    children,
}: {
    id: string;
    side: Side;
    /** Names the pane on its resize handle, e.g. "Job backlog". */
    label: string;
    /** Default share of the row, until the pane is resized. */
    grow: number;
    /** Narrowest the pane gets beside the main column, in px. */
    minWidth: number;
    children: React.ReactNode;
}) {
    const [savedWidth, setSavedWidth] = usePersistentNumber(`floorsync.pane.${id}.width`);
    // Live width mid-drag; only the final width is written to storage.
    const [dragWidth, setDragWidth] = useState<number | null>(null);
    const paneRef = useRef<HTMLDivElement>(null);
    const drag = useRef<{ startX: number; startWidth: number } | null>(null);
    const width = dragWidth ?? savedWidth;

    /** Keeps the pane between its minimum and what leaves the main column
        (and any other pane) their room. */
    const clamp = (next: number) => {
        const pane = paneRef.current;
        const row = pane?.parentElement;
        if (!pane || !row) return Math.max(minWidth, next);
        const style = getComputedStyle(row);
        const gaps = parseFloat(style.columnGap) * (row.children.length - 1);
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const others = Array.from(row.querySelectorAll<HTMLElement>(":scope > [data-side-pane]"))
            .filter((element) => element !== pane)
            .reduce((sum, element) => sum + element.getBoundingClientRect().width, 0);
        const max = row.clientWidth - padding - gaps - others - MAIN_MIN_WIDTH;
        return Math.round(Math.max(minWidth, Math.min(next, max)));
    };

    const currentWidth = () => paneRef.current?.getBoundingClientRect().width ?? minWidth;
    // Dragging towards the main column widens a pane, whichever side it is on.
    const direction = side === "left" ? 1 : -1;

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: currentWidth() };
        setDragWidth(drag.current.startWidth);
    };
    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        setDragWidth(clamp(drag.current.startWidth + (event.clientX - drag.current.startX) * direction));
    };
    const endDrag = () => {
        if (!drag.current) return;
        drag.current = null;
        if (dragWidth !== null) setSavedWidth(dragWidth);
        setDragWidth(null);
    };
    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = event.key === "ArrowRight" ? KEY_STEP : event.key === "ArrowLeft" ? -KEY_STEP : 0;
        if (step !== 0) {
            event.preventDefault();
            setSavedWidth(clamp(currentWidth() + step * direction));
        } else if (event.key === "Enter") {
            event.preventDefault();
            setSavedWidth(null);
        }
    };

    return (
        <div
            ref={paneRef}
            data-side-pane
            className={cn(
                "relative flex min-w-0 flex-col *:flex-1 xl:min-w-(--pane-min)",
                width === null ? "xl:flex-[var(--pane-grow)_1_0%]" : "xl:flex-[0_1_var(--pane-width)]",
            )}
            style={
                {
                    "--pane-grow": grow,
                    "--pane-min": `${minWidth}px`,
                    "--pane-width": width === null ? undefined : `${width}px`,
                } as React.CSSProperties
            }
        >
            {children}
            {/* Sits in the gap beside the pane: a faint rule the full height of
                the pane, with a grip that stays in view while the page scrolls,
                so it reads as something to drag. Double-click or Enter resets. */}
            <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${label}`}
                aria-valuenow={width ?? undefined}
                aria-valuemin={minWidth}
                title="Drag to resize · double-click to reset"
                tabIndex={0}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onDoubleClick={() => setSavedWidth(null)}
                onKeyDown={onKeyDown}
                className={cn(
                    "group/handle absolute inset-y-0 hidden w-4 cursor-col-resize touch-none outline-hidden xl:flex xl:flex-col xl:items-center",
                    side === "left" ? "-right-[18px]" : "-left-[18px]",
                )}
            >
                <span
                    aria-hidden
                    className={cn(
                        "absolute inset-y-0 w-px bg-border transition-colors group-hover/handle:w-0.5 group-hover/handle:bg-primary/60 group-focus-visible/handle:w-0.5 group-focus-visible/handle:bg-primary",
                        dragWidth !== null && "w-0.5 bg-primary",
                    )}
                />
                <span
                    aria-hidden
                    className={cn(
                        "sticky top-[calc(50dvh-1.25rem)] mt-24 flex h-10 w-3.5 items-center justify-center rounded-full border bg-bg text-muted-fg shadow-xs transition-colors group-hover/handle:border-primary/60 group-hover/handle:text-primary group-focus-visible/handle:border-primary group-focus-visible/handle:text-primary",
                        dragWidth !== null && "border-primary text-primary",
                    )}
                >
                    <EllipsisVerticalIcon className="size-3.5 shrink-0" />
                </span>
            </div>
        </div>
    );
}
