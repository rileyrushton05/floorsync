"use client";

import { Slider, SliderFill, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { InfoTooltip } from "@/components/ui/tooltip";
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@heroicons/react/24/outline";
import { MAX_HOUR_PX, type TimelineZoomControls } from "./useTimelineZoom";

const buttonClass =
    "cursor-pointer rounded-md p-1 text-muted-fg outline-hidden transition-colors hover:bg-secondary hover:text-fg focus-visible:outline-2 focus-visible:outline-ring";

/**
 * The zoom slider for the Gantt chart. It drives the same `useTimelineZoom`
 * state as scrolling over the chart, so the two always agree.
 */
export function TimelineZoomBar({
    controls,
    className = "",
}: {
    controls: TimelineZoomControls;
    className?: string;
}) {
    // The slider is a fraction 0-100 mapped logarithmically between the
    // fit-everything minimum and the 5-minute-interval maximum, so equal drags
    // feel like equal zooms across the whole range. A NaN level would reach
    // the thumb input as an invalid `value`, so it falls back to 0.
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
        <div className={`flex w-full max-w-md items-center gap-2 ${className}`}>
            <span className="shrink-0 font-medium text-muted-fg text-xs">Zoom</span>
            <button
                type="button"
                aria-label="Zoom out"
                onClick={() => controls.zoomBy(1 / 1.5)}
                className={buttonClass}
            >
                <MagnifyingGlassMinusIcon className="size-5" />
            </button>
            <Slider
                aria-label="Timeline zoom"
                minValue={0}
                maxValue={100}
                value={level}
                onChange={(value) => setLevel(Array.isArray(value) ? value[0] : value)}
                className="min-w-0 flex-1"
            >
                <SliderTrack className="group-orientation-horizontal:h-2">
                    <SliderFill />
                    <SliderThumb />
                </SliderTrack>
            </Slider>
            <button
                type="button"
                aria-label="Zoom in"
                onClick={() => controls.zoomBy(1.5)}
                className={buttonClass}
            >
                <MagnifyingGlassPlusIcon className="size-5" />
            </button>
            <InfoTooltip label="About timeline zoom">
                You can also scroll over the chart to zoom in and out. Shift + scroll pans
                sideways.
            </InfoTooltip>
        </div>
    );
}
