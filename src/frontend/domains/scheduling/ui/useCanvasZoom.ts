"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

/**
 * Zoom for the job graph, behaving like the Gantt chart's `useTimelineZoom`.
 *
 * The Gantt stretches one axis; a graph has to scale both, so this owns a
 * single scale factor instead of pixels-per-hour. Zoomed all the way out the
 * whole graph fits the viewport; zoomed all the way in it is twice its natural
 * size. Scrolling the wheel over the canvas zooms around the pointer (Alt + +/-
 * zooms around the middle of the view), so what you are looking at stays put.
 * Shift + wheel and sideways trackpad swipes still pan natively.
 */

const MAX_SCALE = 2;
/** Below this the nodes are specks; a graph that still does not fit scrolls. */
const FLOOR_SCALE = 0.1;
/** One notch of a mouse wheel (~100 px of delta) zooms by this factor. */
const WHEEL_NOTCH_FACTOR = 1.2;
const WHEEL_NOTCH_PX = 100;

type Anchor = { x: number; y: number; clientX: number; clientY: number };

export type CanvasZoomControls = {
    /** The live scale factor, already clamped to the fit-everything floor. */
    scale: number;
    /** Bind onto the scroll container. */
    viewportProps: {
        ref: (node: HTMLDivElement | null) => void;
        onPointerEnter: () => void;
        onPointerLeave: () => void;
    };
    /** Bind onto the box sized to the scaled canvas, inside the scroll container. */
    canvasRef: RefObject<HTMLDivElement | null>;
};

export function useCanvasZoom(contentWidth: number, contentHeight: number): CanvasZoomControls {
    const [scale, setScale] = useState(1);
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const [hovered, setHovered] = useState(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLDivElement | null>(null);
    const detachRef = useRef<(() => void) | null>(null);
    // After a zoom the scroll position is corrected so the content point under
    // `clientX/Y` stays there; consumed by the layout effect below.
    const anchorRef = useRef<Anchor | null>(null);

    // Never zoom out past "everything fits", and never force a graph that
    // already fits to shrink below its natural size.
    const fit =
        viewport.width > 0 && contentWidth > 0 && contentHeight > 0
            ? Math.min(viewport.width / contentWidth, viewport.height / contentHeight)
            : 1;
    const minScale = Math.min(1, Math.max(FLOOR_SCALE, fit));

    const clampScale = useCallback(
        (s: number) => Math.min(Math.max(s, minScale), MAX_SCALE),
        [minScale],
    );
    // Derived rather than re-written in an effect, so a resize that raises the
    // floor never leaves a stale, smaller-than-fit scale behind.
    const effectiveScale = clampScale(scale);
    // Latest value for the native listeners, which capture once on attach.
    const liveScale = useRef(effectiveScale);
    useEffect(() => {
        liveScale.current = effectiveScale;
    }, [effectiveScale]);

    const zoomBy = useCallback(
        (factor: number, clientX?: number, clientY?: number) => {
            const el = scrollRef.current;
            const canvas = canvasRef.current;
            const s = liveScale.current;
            const next = clampScale(s * factor);
            if (next === s) return;
            if (el && canvas) {
                const view = el.getBoundingClientRect();
                const px = clientX ?? view.left + view.width / 2;
                const py = clientY ?? view.top + view.height / 2;
                const rect = canvas.getBoundingClientRect();
                anchorRef.current = {
                    x: (px - rect.left) / s,
                    y: (py - rect.top) / s,
                    clientX: px,
                    clientY: py,
                };
            }
            setScale(next);
        },
        [clampScale],
    );

    // Callback ref: measure the viewport and own the wheel listener (a React
    // `onWheel` is passive and cannot preventDefault the page scroll).
    const attach = useCallback(
        (node: HTMLDivElement | null) => {
            detachRef.current?.();
            detachRef.current = null;
            scrollRef.current = node;
            if (!node) return;

            // The viewport is sized by its layout, not by the canvas inside it,
            // so its own content box is the room there is to fit into.
            const measure = () => {
                const style = getComputedStyle(node);
                const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
                const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
                setViewport({
                    width: Math.max(0, node.clientWidth - padX),
                    height: Math.max(0, node.clientHeight - padY),
                });
            };
            measure();
            const observer = new ResizeObserver(measure);
            observer.observe(node);

            let wheelPx = 0;
            let wheelX = 0;
            let wheelY = 0;
            let wheelFrame: number | null = null;

            const flushWheel = () => {
                wheelFrame = null;
                if (wheelPx === 0) return;
                const factor = Math.pow(WHEEL_NOTCH_FACTOR, -wheelPx / WHEEL_NOTCH_PX);
                wheelPx = 0;
                zoomBy(factor, wheelX, wheelY);
            };

            const onWheel = (event: WheelEvent) => {
                if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
                event.preventDefault();
                wheelX = event.clientX;
                wheelY = event.clientY;
                // Line- and page-mode deltas (Firefox mouse wheels) are scaled to
                // pixels, and each event is capped at one notch so a fast flick
                // cannot leap from one end of the range to the other.
                const unit =
                    event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? node.clientHeight : 1;
                const delta = event.deltaY * unit;
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

    // Keep the anchored point under the pointer after a zoom. A layout effect,
    // so the canvas never paints a frame at the new size but the old scroll.
    // Measuring the canvas box (rather than assuming it starts at scroll 0)
    // also covers a small graph that is centred in the viewport.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        const canvas = canvasRef.current;
        const pending = anchorRef.current;
        anchorRef.current = null;
        if (!el || !canvas || !pending) return;
        const rect = canvas.getBoundingClientRect();
        el.scrollLeft += rect.left + pending.x * effectiveScale - pending.clientX;
        el.scrollTop += rect.top + pending.y * effectiveScale - pending.clientY;
    }, [effectiveScale]);

    // Alt + +/- zooms on the keyboard too, while the pointer is over the graph.
    useEffect(() => {
        if (!hovered) return;
        const onKey = (event: KeyboardEvent) => {
            if (!event.altKey) return;
            const zoomIn = event.key === "+" || event.key === "=";
            const zoomOut = event.key === "-" || event.key === "_";
            if (!zoomIn && !zoomOut) return;
            event.preventDefault();
            zoomBy(zoomIn ? WHEEL_NOTCH_FACTOR : 1 / WHEEL_NOTCH_FACTOR);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [hovered, zoomBy]);

    return useMemo(
        () => ({
            scale: effectiveScale,
            viewportProps: {
                ref: attach,
                onPointerEnter: () => setHovered(true),
                onPointerLeave: () => setHovered(false),
            },
            canvasRef,
        }),
        [effectiveScale, attach],
    );
}
