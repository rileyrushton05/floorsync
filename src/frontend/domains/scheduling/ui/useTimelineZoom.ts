"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

/**
 * The zoom state for the Gantt chart, shared by the plan view and the simulation.
 *
 * `useTimelineZoom` owns one number — pixels of track per hour — and keeps the
 * Gantt container's scroll position in step with it. Zoomed all the way out,
 * the whole schedule fits the container exactly; zoomed all the way in, a
 * five-minute interval is wide enough to read. Scrolling the wheel over the
 * chart zooms around the pointer (Alt + +/- zooms around the middle of the
 * view), so what you are looking at stays put.
 */

/** Matches `--gutter` in the Gantt chart: the pinned machine-name column. */
export const TIMELINE_GUTTER_PX = 168;
/** Pixels per hour at maximum zoom: a five-minute interval is 56 px wide. */
export const MAX_HOUR_PX = 672;
export const DEFAULT_HOUR_PX = 124;
const FALLBACK_MIN_HOUR_PX = 6;
/** One notch of a mouse wheel (~100 px of delta) zooms by this factor. */
const WHEEL_NOTCH_FACTOR = 1.2;
const WHEEL_NOTCH_PX = 100;

export type TimelineZoomControls = {
    /** Pixels of track per hour — the zoom level itself. */
    hourPx: number;
    /** Bind onto the Gantt chart's scroll container. */
    chartProps: {
        ref: (node: HTMLDivElement | null) => void;
        onPointerEnter: () => void;
        onPointerLeave: () => void;
    };
};

export function useTimelineZoom(totalMins: number): TimelineZoomControls {
    const [hourPx, setHourPx] = useState(DEFAULT_HOUR_PX);
    const [containerWidth, setContainerWidth] = useState(0);
    const [hovered, setHovered] = useState(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const detachRef = useRef<(() => void) | null>(null);
    // After a zoom the scroll position is corrected so `anchorMins` stays at
    // `offsetPx` past the left edge; consumed by the effect below.
    const anchorRef = useRef<{ anchorMins: number; offsetPx: number } | null>(null);

    const hours = Math.max(1, totalMins / 60);
    const timeArea = Math.max(0, containerWidth - TIMELINE_GUTTER_PX);
    const minHourPx =
        timeArea > 0 && totalMins > 0
            ? Math.max(FALLBACK_MIN_HOUR_PX, timeArea / hours)
            : FALLBACK_MIN_HOUR_PX;

    const clampHourPx = useCallback(
        (h: number) => Math.min(Math.max(h, minHourPx), MAX_HOUR_PX),
        [minHourPx],
    );
    // The live zoom level: the stored one clamped to the container's fit-everything
    // floor, so a resize that shrinks the container never leaves the chart wider
    // than the whole schedule. Kept derived rather than re-written in an effect.
    const effectiveHourPx = clampHourPx(hourPx);
    // Latest values for the native listeners, which capture once on attach.
    const liveRef = useRef({ hourPx: effectiveHourPx, totalMins });
    useEffect(() => {
        liveRef.current = { hourPx: effectiveHourPx, totalMins };
    }, [effectiveHourPx, totalMins]);

    const maxScroll = useCallback((h: number, el: HTMLDivElement) => {
        return Math.max(
            0,
            TIMELINE_GUTTER_PX + (liveRef.current.totalMins / 60) * h - el.clientWidth,
        );
    }, []);

    const zoomBy = useCallback(
        (factor: number, anchorMins?: number) => {
            const el = scrollRef.current;
            const h = liveRef.current.hourPx;
            const at =
                anchorMins ??
                (el
                    ? (el.scrollLeft + Math.max(0, el.clientWidth - TIMELINE_GUTTER_PX) / 2) / h
                    : 0);
            const next = clampHourPx(h * factor);
            if (next === h) return;
            if (el) anchorRef.current = { anchorMins: at, offsetPx: at * h - el.scrollLeft };
            setHourPx(next);
        },
        [clampHourPx],
    );

    // Callback ref: observe the scroll container and own the wheel listener
    // (a React `onWheel` is passive and cannot preventDefault the page scroll).
    const attach = useCallback(
        (node: HTMLDivElement | null) => {
            detachRef.current?.();
            detachRef.current = null;
            scrollRef.current = node;
            if (!node) return;

            setContainerWidth(node.clientWidth);
            const observer = new ResizeObserver(() => setContainerWidth(node.clientWidth));
            observer.observe(node);

            let wheelPx = 0;
            let wheelAnchorMins = 0;
            let wheelFrame: number | null = null;

            const flushWheel = () => {
                wheelFrame = null;
                if (wheelPx === 0) return;
                const factor = Math.pow(WHEEL_NOTCH_FACTOR, -wheelPx / WHEEL_NOTCH_PX);
                wheelPx = 0;
                zoomBy(factor, wheelAnchorMins);
            };

            const onWheel = (event: WheelEvent) => {
                // Sideways trackpad swipes and Shift + wheel still pan natively;
                // only a vertical scroll stretches the timeline.
                if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
                event.preventDefault();
                const rect = node.getBoundingClientRect();
                const h = liveRef.current.hourPx;
                wheelAnchorMins = Math.max(
                    0,
                    (node.scrollLeft + event.clientX - rect.left - TIMELINE_GUTTER_PX) / h,
                );
                // Line- and page-mode deltas (Firefox mouse wheels) are scaled to
                // pixels, and each event is capped at one notch so a fast flick
                // cannot leap from one end of the range to the other.
                const scale =
                    event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? node.clientHeight : 1;
                const delta = event.deltaY * scale;
                wheelPx += Math.max(-WHEEL_NOTCH_PX, Math.min(WHEEL_NOTCH_PX, delta));
                if (wheelFrame === null) {
                    wheelFrame = requestAnimationFrame(flushWheel);
                }
            };

            node.addEventListener("wheel", onWheel, { passive: false });

            detachRef.current = () => {
                observer.disconnect();
                node.removeEventListener("wheel", onWheel);
                if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
            };
        },
        [zoomBy],
    );

    // Keep the scroll position anchored (and inside the schedule) after every
    // zoom level change.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const pending = anchorRef.current;
        anchorRef.current = null;
        const target = pending
            ? pending.anchorMins * hourPx - pending.offsetPx
            : el.scrollLeft;
        el.scrollLeft = Math.min(Math.max(target, 0), maxScroll(hourPx, el));
    }, [hourPx, maxScroll]);

    // A new schedule changes the total; keep the scroll position inside it.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollLeft = Math.min(el.scrollLeft, maxScroll(liveRef.current.hourPx, el));
    }, [totalMins, maxScroll]);

    // Alt + +/- zooms on the keyboard too, while the pointer is over the chart.
    useEffect(() => {
        if (!hovered) return;
        const onKey = (event: KeyboardEvent) => {
            if (!event.altKey) return;
            const zoomIn = event.key === "+" || event.key === "=";
            const zoomOut = event.key === "-" || event.key === "_";
            if (!zoomIn && !zoomOut) return;
            event.preventDefault();
            zoomBy(zoomIn ? 1.2 : 1 / 1.2);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [hovered, zoomBy]);

    return useMemo(
        () => ({
            hourPx: effectiveHourPx,
            chartProps: {
                ref: attach,
                onPointerEnter: () => setHovered(true),
                onPointerLeave: () => setHovered(false),
            },
        }),
        [effectiveHourPx, attach],
    );
}

/** The style that pins a zoom level onto the Gantt chart's `--hour` variable. */
export function timelineHourStyle(hourPx: number): CSSProperties {
    return { "--hour": `${hourPx}px` } as CSSProperties;
}
