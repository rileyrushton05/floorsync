"use client";

import { Slider, SliderFill, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@heroicons/react/24/outline";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
} from "react";

/**
 * The zoom bar (After Effects-style timeline navigator) and the zoom state it
 * drives, shared by the plan view and the simulation.
 *
 * `useTimelineZoom` owns one number — pixels of track per hour — and the scroll
 * position of the Gantt container. Zoomed all the way out, the whole schedule
 * fits the container exactly; zoomed all the way in, a five-minute interval is
 * wide enough to read. Zooming anchors on the pointer (Alt + wheel) or the
 * middle of the view (Alt + +/-), so what you are looking at stays put.
 *
 * `TimelineNavigator` draws the whole schedule as a bar with the visible window
 * cut out of it. Drag the window to pan, drag its edges to zoom, or click
 * anywhere to jump. It reads and writes the same state the chart scrolls in,
 * so the two can never disagree.
 */

/** Matches `--gutter` in the Gantt chart: the pinned machine-name column. */
export const TIMELINE_GUTTER_PX = 168;
/** Pixels per hour at maximum zoom: a five-minute interval is 56 px wide. */
export const MAX_HOUR_PX = 672;
export const DEFAULT_HOUR_PX = 124;
const FALLBACK_MIN_HOUR_PX = 6;

/** The slice of the schedule currently on screen, in plan minutes. */
export type TimelineView = { startMins: number; endMins: number };

export type TimelineZoomControls = {
    /** Pixels of track per hour — the zoom level itself. */
    hourPx: number;
    /** Smallest `hourPx` before the whole schedule fits the container. */
    minHourPx: number;
    /** Smallest visible window, in plan minutes, at maximum zoom. */
    minVisibleMins: number;
    /** Width of the scroll container, measured live. */
    containerWidth: number;
    view: TimelineView;
    /** Bind onto the Gantt chart's scroll container. */
    chartProps: {
        ref: (node: HTMLDivElement | null) => void;
        onPointerEnter: () => void;
        onPointerLeave: () => void;
    };
    zoomBy: (factor: number, anchorMins?: number) => void;
    /** Zoom to an absolute level, in pixels of track per hour. */
    setZoomLevel: (hourPx: number) => void;
    /** Pan so `startMins` sits at the left edge of the time area. */
    scrollToMins: (startMins: number) => void;
    /**
     * Zoom so `visibleMins` are on screen, holding `fixedMins` still at the
     * anchored edge.
     */
    setVisible: (
        fixedMins: number,
        visibleMins: number,
        anchor: "start" | "end",
    ) => void;
};

export function useTimelineZoom(totalMins: number): TimelineZoomControls {
    const [hourPx, setHourPx] = useState(DEFAULT_HOUR_PX);
    const [containerWidth, setContainerWidth] = useState(0);
    const [view, setView] = useState<TimelineView>({ startMins: 0, endMins: totalMins });
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
    const minVisibleMins = Math.max(
        1,
        (Math.max(0, containerWidth - TIMELINE_GUTTER_PX) || 600) / MAX_HOUR_PX,
    );

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

    const measure = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const h = liveRef.current.hourPx;
        const total = liveRef.current.totalMins;
        const start = el.scrollLeft / h;
        const visible = Math.max(0, el.clientWidth - TIMELINE_GUTTER_PX) / h;
        setView({
            startMins: Math.max(0, start),
            endMins: Math.min(total, start + visible),
        });
    }, []);

    const maxScroll = useCallback(
        (h: number, el: HTMLDivElement | null) => {
            const node = el ?? scrollRef.current;
            if (!node) return 0;
            return Math.max(
                0,
                TIMELINE_GUTTER_PX + (liveRef.current.totalMins / 60) * h - node.clientWidth,
            );
        },
        [],
    );

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

    /** Zoom to an absolute level, in pixels of track per hour. */
    const setZoomLevel = useCallback(
        (nextRaw: number) => {
            const el = scrollRef.current;
            const h = liveRef.current.hourPx;
            const next = clampHourPx(nextRaw);
            if (next === h) return;
            const at = el
                ? (el.scrollLeft + Math.max(0, el.clientWidth - TIMELINE_GUTTER_PX) / 2) / h
                : 0;
            if (el) anchorRef.current = { anchorMins: at, offsetPx: at * h - el.scrollLeft };
            setHourPx(next);
        },
        [clampHourPx],
    );

    const scrollToMins = useCallback(
        (startMins: number) => {
            const el = scrollRef.current;
            if (!el) return;
            const h = liveRef.current.hourPx;
            el.scrollLeft = Math.min(Math.max(startMins * h, 0), maxScroll(h, el));
            measure();
        },
        [measure, maxScroll],
    );

    const setVisible = useCallback(
        (fixedMins: number, visibleMins: number, anchor: "start" | "end") => {
            const el = scrollRef.current;
            if (!el) return;
            const area = Math.max(0, el.clientWidth - TIMELINE_GUTTER_PX);
            const h = liveRef.current.hourPx;
            const next = clampHourPx(area / Math.max(visibleMins, 0.5));
            const anchorPx = anchor === "start" ? 0 : area;
            if (next === h) {
                // Already at the zoom limit; just pan the fixed edge into place.
                el.scrollLeft = Math.min(
                    Math.max(fixedMins * h - anchorPx, 0),
                    maxScroll(h, el),
                );
                measure();
                return;
            }
            anchorRef.current = { anchorMins: fixedMins, offsetPx: anchorPx };
            setHourPx(next);
        },
        [clampHourPx, maxScroll, measure],
    );

    // Callback ref: observe the scroll container and own the native listeners
    // (a React `onWheel` cannot preventDefault, which Alt + scroll needs).
    const attach = useCallback(
        (node: HTMLDivElement | null) => {
            detachRef.current?.();
            detachRef.current = null;
            scrollRef.current = node;
            if (!node) return;

            setContainerWidth(node.clientWidth);
            const observer = new ResizeObserver(() => {
                setContainerWidth(node.clientWidth);
                measure();
            });
            observer.observe(node);
            const onScroll = () => measure();

            let wheelAccumulator = 0;
            let wheelAnchorMins = 0;
            let wheelFrame: number | null = null;

            const flushWheel = () => {
                wheelFrame = null;
                if (wheelAccumulator === 0) return;
                const factor = Math.pow(1.2, wheelAccumulator);
                wheelAccumulator = 0;
                zoomBy(factor, wheelAnchorMins);
            };

            const onWheel = (event: WheelEvent) => {
                if (!event.altKey) return;
                event.preventDefault();
                const rect = node.getBoundingClientRect();
                const h = liveRef.current.hourPx;
                wheelAnchorMins =
                    (event.clientX - rect.left - node.scrollLeft - TIMELINE_GUTTER_PX) / h;
                wheelAccumulator += event.deltaY < 0 ? 1 : -1;
                if (wheelFrame === null) {
                    wheelFrame = requestAnimationFrame(flushWheel);
                }
            };

            node.addEventListener("scroll", onScroll, { passive: true });
            node.addEventListener("wheel", onWheel, { passive: false });
            measure();

            detachRef.current = () => {
                observer.disconnect();
                node.removeEventListener("scroll", onScroll);
                node.removeEventListener("wheel", onWheel);
                if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
            };
        },
        [measure, zoomBy],
    );

    useEffect(() => {
        measure();
    }, [containerWidth, effectiveHourPx, measure]);

    // Keep the scroll position anchored (and inside the schedule) after every
    // zoom level change.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) {
            measure();
            return;
        }
        const pending = anchorRef.current;
        anchorRef.current = null;
        const target = pending
            ? pending.anchorMins * hourPx - pending.offsetPx
            : el.scrollLeft;
        el.scrollLeft = Math.min(Math.max(target, 0), maxScroll(hourPx, el));
        measure();
    }, [hourPx, measure, maxScroll]);

    // A new schedule changes the total; make sure the view still describes it.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollLeft = Math.min(el.scrollLeft, maxScroll(liveRef.current.hourPx, el));
        measure();
    }, [totalMins, measure, maxScroll]);

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
            minHourPx,
            minVisibleMins,
            containerWidth,
            view,
            chartProps: {
                ref: attach,
                onPointerEnter: () => setHovered(true),
                onPointerLeave: () => setHovered(false),
            },
            zoomBy,
            setZoomLevel,
            scrollToMins,
            setVisible,
        }),
        [
            effectiveHourPx,
            minHourPx,
            minVisibleMins,
            containerWidth,
            view,
            attach,
            zoomBy,
            setZoomLevel,
            scrollToMins,
            setVisible,
        ],
    );
}

export function TimelineNavigator({
    controls,
    className = "",
}: {
    controls: TimelineZoomControls;
    className?: string;
}) {
    // The slider is a fraction 0-100 mapped logarithmically between the
    // fit-everything minimum and the 5-minute-interval maximum, so equal drags
    // feel like equal zooms across the whole range. A guard rather than trust:
    // a NaN control value would otherwise reach the thumb input as an invalid
    // `value` attribute (React warns, and the track collapses).
    const span = Math.log(MAX_HOUR_PX / controls.minHourPx);
    const rawLevel =
        span > 0
            ? Math.min(
                Math.max((100 * Math.log(controls.hourPx / controls.minHourPx)) / span, 0),
                100,
            )
            : 100;
    const level = Number.isFinite(rawLevel) ? rawLevel : 0;
    const setLevel = (fraction: number) =>
        controls.setZoomLevel(
            controls.minHourPx * Math.pow(MAX_HOUR_PX / controls.minHourPx, fraction / 100),
        );

    return (
        <div className={`flex shrink-0 items-center gap-1.5 ${className}`}>
            <button
                type="button"
                aria-label="Zoom out"
                onClick={() => controls.zoomBy(1 / 1.5)}
                className="cursor-pointer rounded-xs p-0.5 text-muted-fg outline-hidden transition-colors hover:bg-secondary hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
            >
                <MagnifyingGlassMinusIcon className="size-4" />
            </button>
            <Slider
                aria-label="Timeline zoom"
                minValue={0}
                maxValue={100}
                value={level}
                onChange={(value) => setLevel(Array.isArray(value) ? value[0] : value)}
                className="w-28"
            >
                <SliderTrack>
                    <SliderFill />
                    <SliderThumb className="size-3.5" />
                </SliderTrack>
            </Slider>
            <button
                type="button"
                aria-label="Zoom in"
                onClick={() => controls.zoomBy(1.5)}
                className="cursor-pointer rounded-xs p-0.5 text-muted-fg outline-hidden transition-colors hover:bg-secondary hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
            >
                <MagnifyingGlassPlusIcon className="size-4" />
            </button>
        </div>
    );
}

/** The style that pins a zoom level onto the Gantt chart's `--hour` variable. */
export function timelineHourStyle(hourPx: number): CSSProperties {
    return { "--hour": `${hourPx}px` } as CSSProperties;
}
