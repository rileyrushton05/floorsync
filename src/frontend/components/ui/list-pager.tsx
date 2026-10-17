"use client";

import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How many rows a list shows before it folds the rest behind a toggle.
 *
 * Enough to fill the panel without scrolling on a short list, small enough
 * that the footer is reachable without scrolling on a long one.
 */
export const COLLAPSED_ROW_LIMIT = 16;

/**
 * State for a list panel that shows a collapsed slice by default.
 *
 * Returns the rows to render, how many were folded away, whether the
 * collapsed footer should be highlighted (the selected row sits below the
 * fold), and a callback that expands the list and scrolls the selected row
 * into view.
 *
 * Auto-expanding when a hidden row is selected would flip the toggle under
 * the pointer without warning; highlighting it instead reads as "the thing
 * you are looking at is under here", and one click brings it into view.
 */
export function useCollapsedRows<T extends { id: string }>(rows: readonly T[], selectedId: string | null) {
    const [expanded, setExpanded] = useState(false);
    // Remembered between the toggle click and the effect: the row to scroll to.
    const scrollTargetRef = useRef<string | null>(null);

    const shown = expanded ? rows : rows.slice(0, COLLAPSED_ROW_LIMIT);
    const hiddenCount = rows.length - shown.length;
    const selectedIsHidden =
        selectedId !== null && !shown.some((row) => row.id === selectedId) && rows.some((row) => row.id === selectedId);

    const toggle = useCallback(() => {
        if (expanded) {
            setExpanded(false);
            return;
        }
        if (selectedIsHidden) scrollTargetRef.current = selectedId;
        setExpanded(true);
    }, [expanded, selectedId, selectedIsHidden]);

    // After an expand that was meant to reveal the selection, bring it into
    // view. Runs after paint, so the row exists in the DOM to scroll to.
    useEffect(() => {
        if (!expanded) return;
        const target = scrollTargetRef.current;
        if (target === null) return;
        scrollTargetRef.current = null;
        const frame = requestAnimationFrame(() => {
            document
                .querySelector<HTMLElement>(`[data-row-id="${CSS.escape(target)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
        return () => cancelAnimationFrame(frame);
    }, [expanded]);

    return { shown, hiddenCount, expanded, selectedIsHidden, toggle };
}

/**
 * The footer of a paginated list panel: a single full-width button that
 * stacks three centred lines — the "+N more" count (only while collapsed),
 * the click-to-expand / click-to-collapse label, and a chevron that rotates
 * 180° when expanded. One hit target for all three.
 *
 * `highlighted` gives the button the same tint as a selected row, for the
 * case where the selected row itself is below the fold.
 */
export function ExpandListButton({
    hiddenCount,
    expanded,
    highlighted = false,
    onToggle,
    noun,
}: {
    hiddenCount: number;
    expanded: boolean;
    /** The selected row is below the fold; the button reads as it. */
    highlighted?: boolean;
    onToggle: () => void;
    /** Plural noun for the "+N more" line, e.g. "machines". */
    noun: string;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className={`group/pager flex w-full flex-col items-center gap-0.5 rounded-lg border py-2.5 transition-colors ${
                highlighted
                    ? "border-primary/30 bg-primary/15 text-primary-subtle-fg hover:bg-primary/20"
                    : "border-border bg-transparent text-muted-fg hover:bg-muted hover:text-fg"
            }`}
        >
            {/* Hidden once expanded: the count is only about what is folded
                away, so an expanded button keeps its two lines. */}
            {hiddenCount > 0 && !expanded && (
                <span className="text-muted-fg text-xs" role="status">
                    +{hiddenCount} more {noun}
                </span>
            )}
            <span className={`font-medium text-sm ${expanded ? "" : "text-fg"}`}>
                {expanded ? "Click to collapse" : "Click to expand"}
            </span>
            <ChevronDownIcon
                aria-hidden
                className={`size-5 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
            />
        </button>
    );
}

/**
 * Wraps `ExpandListButton` with the hidden-count bookkeeping and the slot
 * below it (e.g. a pinned add button) that list panels use.
 */
export function ListPager({
    hiddenCount,
    expanded,
    highlighted,
    onToggle,
    noun,
    children,
}: {
    hiddenCount: number;
    expanded: boolean;
    /** The selected row is below the fold; the toggle reads as it. */
    highlighted: boolean;
    onToggle: () => void;
    /** Plural noun for the "+N more" line, e.g. "machines". */
    noun: string;
    /** Optional extra content (e.g. an add button) below the toggle. */
    children?: React.ReactNode;
}) {
    if (hiddenCount === 0 && !expanded) {
        return children ? <div className="mt-auto pt-3">{children}</div> : null;
    }
    return (
        <div className="mt-3">
            <ExpandListButton
                hiddenCount={hiddenCount}
                expanded={expanded}
                highlighted={highlighted}
                onToggle={onToggle}
                noun={noun}
            />
            {children && <div className="mt-3">{children}</div>}
        </div>
    );
}
