"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components/Button";
import { ToggleButton } from "react-aria-components/ToggleButton";
import { jobColor, tint, type JobColor } from "../colors";
import { formatDuration, formatOffset } from "../format";
import type { GeneratedSchedule, JobDef, Machine } from "../types";
import { TimelineZoomBar } from "./TimelineZoomBar";
import { DEFAULT_HOUR_PX, TIMELINE_GUTTER_PX, timelineHourStyle, type TimelineZoomControls } from "./useTimelineZoom";

/**
 * The schedule grid, shared by the plan view and the simulation.
 *
 * In `plan` mode it draws the generated schedule as-is: every block is the
 * colour of its job, so a job can be traced across machines. In `simulation`
 * mode the same geometry is re-shaded by where `nowMins` falls, and a "now"
 * line is drawn — so the two views are visibly different reads of one plan
 * rather than two versions of the same picture.
 *
 * Geometry comes from two CSS custom properties, `--gutter` and `--hour`, and
 * every offset is `calc()`-ed from them. Nothing is a percentage, so the hour
 * ruler and the blocks underneath it cannot drift apart.
 *
 * Intent UI ships no timeline or Gantt component, so this stays bespoke — but
 * it is built on the same React Aria primitives Intent UI wraps, and paints
 * itself from the same theme tokens, so it belongs to the same system.
 */

type OperationState = "plan" | "done" | "running" | "upcoming";

function operationState(startMins: number, endMins: number, nowMins: number | null): OperationState {
    if (nowMins === null) return "plan";
    if (endMins <= nowMins) return "done";
    if (startMins <= nowMins) return "running";
    return "upcoming";
}

function blockStyle(color: JobColor, state: OperationState): React.CSSProperties {
    switch (state) {
        case "done":
            return { background: tint(color.fill, 0.34), color: "#0b0b0b", borderColor: tint(color.fill, 0.62) };
        case "upcoming":
            return { background: tint(color.fill, 0.14), color: "#334155", borderColor: tint(color.fill, 0.45) };
        default: // "plan" and "running" both show the job at full strength
            return { background: color.fill, color: color.ink, borderColor: color.fill };
    }
}

/** Arrow-key scrub step in simulated minutes; Shift steps a whole hour. */
const SCRUB_STEP_MINS = 15;

const STATE_MARK: Record<OperationState, string> = {
    plan: "",
    done: "✓ ",
    running: "▶ ",
    upcoming: "",
};

export function GanttChart({
    machines,
    jobs,
    schedule,
    colors,
    mode,
    nowMins = null,
    selectedJobId = null,
    highlightedMachineId = null,
    onSelectJob,
    zoom = null,
    onScrub = null,
    onScrubEnd = null,
    followNow = false,
}: {
    machines: Machine[];
    jobs: JobDef[];
    schedule: GeneratedSchedule;
    colors: Map<string, JobColor>;
    mode: "plan" | "simulation";
    nowMins?: number | null;
    selectedJobId?: string | null;
    highlightedMachineId?: string | null;
    onSelectJob?: (jobId: string) => void;
    /** Live zoom state from `useTimelineZoom`; omit for the fixed default scale. */
    zoom?: TimelineZoomControls | null;
    /** In simulation mode, drag the "now" line to move the clock to `mins`. */
    onScrub?: ((mins: number) => void) | null;
    /** A pointer scrub was released, so the last `onScrub` value is final. */
    onScrubEnd?: (() => void) | null;
    /** Keep the "now" line in view as it advances, scrolling the chart if needed. */
    followNow?: boolean;
}) {
    const now = mode === "simulation" ? nowMins : null;
    // Where scrubbing starts from before playback has begun: the plan's start.
    const scrubNow = now ?? 0;
    const hours = Math.max(1, Math.ceil(schedule.makespanMins / 60));
    const jobName = (jobId: string) => jobs.find((job) => job.id === jobId)?.name ?? jobId;
    const [hoveredOpId, setHoveredOpId] = useState<string | null>(null);
    const chartRef = useRef<HTMLDivElement | null>(null);
    // The zoom hook needs the scroll container too; spreading its props after
    // `ref={chartRef}` would silently replace this ref and break scrubbing.
    const zoomRef = zoom?.chartProps.ref;
    const attachChart = useCallback(
        (node: HTMLDivElement | null) => {
            chartRef.current = node;
            zoomRef?.(node);
        },
        [zoomRef],
    );

    // Dragging the "now" line scrubs the clock: convert the pointer's x, which
    // lives in screen space, back into plan minutes via the live hour scale.
    const scrubTo = useCallback(
        (clientX: number) => {
            const chart = chartRef.current;
            if (!chart || !onScrub) return;
            const rect = chart.getBoundingClientRect();
            const hourPx = zoom?.hourPx ?? DEFAULT_HOUR_PX;
            // The track scrolls under the pinned gutter, so add back what has
            // scrolled off the left edge.
            const mins = ((clientX - rect.left - TIMELINE_GUTTER_PX + chart.scrollLeft) / hourPx) * 60;
            onScrub(Math.max(0, Math.min(schedule.makespanMins, mins)));
        },
        [onScrub, schedule.makespanMins, zoom?.hourPx],
    );
    const onNowPointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!onScrub) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            scrubTo(event.clientX);
        },
        [onScrub, scrubTo],
    );
    const onNowPointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            // Pointer capture keeps the drag alive even when the pointer leaves
            // the chart, and the buttons filter out non-drag moves.
            if (event.buttons & 1) scrubTo(event.clientX);
        },
        [scrubTo],
    );
    const onNowKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (!onScrub) return;
            const stepMins = event.shiftKey ? 60 : SCRUB_STEP_MINS;
            let next: number | null = null;
            if (event.key === "ArrowLeft") next = scrubNow - stepMins;
            if (event.key === "ArrowRight") next = scrubNow + stepMins;
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = schedule.makespanMins;
            if (next === null) return;
            event.preventDefault();
            onScrub(Math.max(0, Math.min(schedule.makespanMins, next)));
        },
        [onScrub, schedule.makespanMins, scrubNow],
    );
    const onScrubPointerUp = useCallback(() => onScrubEnd?.(), [onScrubEnd]);

    // While playing, page the chart along with the clock once the line nears
    // the right edge, so a zoomed-in view does not watch an empty stretch. A
    // line the manager scrolled away from stays put until it reaches view.
    const hourPx = zoom?.hourPx ?? DEFAULT_HOUR_PX;
    useEffect(() => {
        const chart = chartRef.current;
        if (!followNow || !chart || now === null) return;
        const lineX = (now / 60) * hourPx;
        const viewStart = chart.scrollLeft;
        const viewWidth = chart.clientWidth - TIMELINE_GUTTER_PX;
        if (viewWidth <= 0) return;
        if (lineX > viewStart + viewWidth * 0.9 || lineX < viewStart) {
            chart.scrollLeft = Math.max(0, lineX - viewWidth * 0.1);
        }
    }, [followNow, hourPx, now]);
    const usedMachines = machines.filter((machine) =>
        schedule.ops.some((op) => op.machineId === machine.id),
    );
    const scheduledJobIds = schedule.order;

    return (
        <div
            className="flex min-h-0 min-w-0 flex-col [--gutter:168px]"
            style={timelineHourStyle(zoom?.hourPx ?? DEFAULT_HOUR_PX)}
        >
            {zoom && <TimelineZoomBar controls={zoom} className="mb-2 self-end" />}
            {/* The chart is routinely several screens wide, so the scrollbar is a
                primary control here and `scroll-rail` gives it a real size and
                colour. `max-h` keeps the bottom edge — where the horizontal bar
                lives — on screen instead of pushing it below the fold once a
                floor has more machines than fit; the header and machine column
                are sticky, so scrolling inside the box never loses your place.
                `overscroll-x-contain` stops a trackpad swipe past the end from
                turning into browser back-navigation. */}
            <div
                className="scroll-rail max-h-[68dvh] min-h-0 flex-1 overflow-auto overscroll-x-contain rounded-lg border bg-muted"
                {...(zoom ? zoom.chartProps : {})}
                ref={attachChart}
            >
                <div
                    className="relative flex flex-col"
                    style={{ width: `calc(var(--gutter) + var(--hour) * ${hours})` }}
                >
                    <div className="sticky top-0 z-3 flex border-b bg-overlay">
                        {/* Pinned like the machine names below it. Without this the
                            label scrolls away and the hour ruler slides across to sit
                            above the frozen column, so the two disagree about what
                            x = 0 means the moment anyone scrolls right. */}
                        <div className="sticky start-0 z-1 w-(--gutter) shrink-0 border-e bg-muted px-2.5 py-2 font-bold text-[0.68rem] text-muted-fg uppercase tracking-[0.05em]">
                            Elapsed →
                        </div>
                        {/* Zoomed out, one hour can be a few pixels wide; label a
                            stride that keeps the ruler readable instead of one
                            cell per hour. */}
                        {(() => {
                            const hourPx = zoom?.hourPx ?? DEFAULT_HOUR_PX;
                            const stride = Math.max(1, Math.ceil(36 / hourPx));
                            return Array.from({ length: hours }, (_, hour) => (
                                <div
                                    key={hour}
                                    className="w-(--hour) shrink-0 overflow-hidden border-s py-2 ps-1.5 font-semibold text-muted-fg text-xs tabular-nums"
                                >
                                    {hour % stride === 0
                                        ? hour === 0 ? "T+0h" : `${hour}h`
                                        : ""}
                                </div>
                            ));
                        })()}
                        {onScrub && mode === "simulation" && (
                            /* The black hour ruler doubles as a scrub surface:
                               pressing anywhere along it jumps the clock there and
                               dragging continues the scrub, exactly like the
                               narrower grab strip on the now-line below. */
                            <div
                                role="slider"
                                tabIndex={0}
                                aria-label="Scrub the simulation clock along the hour ruler"
                                aria-valuemin={0}
                                aria-valuemax={schedule.makespanMins}
                                aria-valuenow={Math.round(scrubNow)}
                                aria-valuetext={formatOffset(scrubNow)}
                                className="absolute inset-y-0 right-0 left-(--gutter) cursor-ew-resize touch-none outline-hidden hover:bg-primary/5 focus-visible:bg-primary/10"
                                onPointerDown={onNowPointerDown}
                                onPointerMove={onNowPointerMove}
                                onPointerUp={onScrubPointerUp}
                                onKeyDown={onNowKeyDown}
                            />
                        )}
                    </div>

                    {usedMachines.map((machine) => (
                        <div
                            key={machine.id}
                            className={`flex border-b last-of-type:border-b-0 ${highlightedMachineId === machine.id ? "bg-primary/10" : "bg-overlay"
                                }`}
                        >
                            <div
                                className={`sticky start-0 z-2 w-(--gutter) shrink-0 border-e p-2.5 ${highlightedMachineId === machine.id ? "bg-primary/15" : "bg-muted"
                                    }`}
                            >
                                <div className="font-bold text-fg text-sm">{machine.name}</div>
                                <div className="text-muted-fg text-xs">{machine.operator}</div>
                            </div>
                            <div className="relative h-13 flex-1 bg-[repeating-linear-gradient(to_right,var(--color-border)_0,var(--color-border)_1px,transparent_1px,transparent_var(--hour))]">
                                {schedule.ops
                                    .filter((op) => op.machineId === machine.id)
                                    .map((op) => {
                                        const color = jobColor(colors, op.jobId);
                                        const state = operationState(op.startMins, op.endMins, now);
                                        const durationMins = op.endMins - op.startMins;
                                        const dimmed = selectedJobId !== null && selectedJobId !== op.jobId;
                                        // A short block cannot fit both tokens; the operation name
                                        // is the one that survives, since the block's colour (and
                                        // the legend) already says which job it belongs to.
                                        const compact = durationMins < 45;
                                        const progressPct =
                                            state === "running" && now !== null
                                                ? ((now - op.startMins) / durationMins) * 100
                                                : 0;

                                        const hovered = hoveredOpId === op.opId;

                                        return (
                                            <Button
                                                key={op.opId}
                                                className={`absolute top-1.75 flex h-9.5 min-w-1 cursor-pointer items-center overflow-hidden rounded-sm border px-1.5 text-left font-semibold text-xs outline-hidden transition-colors focus-visible:z-4 focus-visible:outline-2 focus-visible:outline-fg focus-visible:outline-offset-1 ${dimmed ? "opacity-28" : ""
                                                    }`}
                                                style={{
                                                    ...blockStyle(color, state),
                                                    // Hover lightens the block to a wash of its own
                                                    // colour, keeping the job identifiable.
                                                    ...(hovered
                                                        ? {
                                                            background: tint(color.fill, 0.45),
                                                            borderColor: tint(color.fill, 0.55),
                                                            color: "#334155",
                                                        }
                                                        : {}),
                                                    left: `calc(var(--hour) * ${op.startMins / 60})`,
                                                    width: `calc(var(--hour) * ${durationMins / 60} - 2px)`,
                                                }}
                                                onHoverStart={() => setHoveredOpId(op.opId)}
                                                onHoverEnd={() => setHoveredOpId(null)}
                                                onPress={() => onSelectJob?.(op.jobId)}
                                                aria-label={`${jobName(op.jobId)}, operation ${op.opIndex} of ${op.opTotal}, ${op.opName}, on ${machine.name}, starts ${formatOffset(op.startMins)}, runs ${formatDuration(durationMins)}${state === "plan" ? "" : `, ${state}`}`}
                                            >
                                                <span className="block truncate leading-tight">
                                                    {STATE_MARK[state]}
                                                    {compact
                                                        ? op.opName
                                                        : `${op.opName} · ${jobName(op.jobId)}`}
                                                </span>
                                                {state === "running" && (
                                                    <span
                                                        className="absolute bottom-0 left-0 h-[3px] opacity-85"
                                                        style={{ width: `${progressPct}%`, background: color.ink }}
                                                    />
                                                )}
                                            </Button>
                                        );
                                    })}
                            </div>
                        </div>
                    ))}

                    {now !== null && (
                        <div
                            className="absolute top-0 bottom-0 z-1 w-0"
                            style={{ left: `calc(var(--gutter) + var(--hour) * ${now / 60})` }}
                        >
                            {/* z-1 sits above the operation blocks but below the pinned
                                machine-name column (z-2) and hour ruler (z-3), so the
                                line can never paint across the side headings when the
                                chart is scrolled — it simply slides underneath them. */}
                            {onScrub ? (
                                // The whole bar is the control: grab the line or the
                                // flag anywhere and drag, or focus it and use the
                                // arrow keys (±15 min, ±60 with Shift).
                                <div
                                    role="slider"
                                    tabIndex={0}
                                    aria-label="Scrub the simulation clock"
                                    aria-valuemin={0}
                                    aria-valuemax={schedule.makespanMins}
                                    aria-valuenow={Math.round(now)}
                                    aria-valuetext={formatOffset(now)}
                                    className="group absolute top-0 bottom-0 -left-2.5 w-5 cursor-ew-resize touch-none outline-hidden focus-visible:outline-2 focus-visible:outline-fg focus-visible:outline-offset-1"
                                    onPointerDown={onNowPointerDown}
                                    onPointerMove={onNowPointerMove}
                                    onPointerUp={onScrubPointerUp}
                                    onKeyDown={onNowKeyDown}
                                >
                                    <span className="pointer-events-none absolute top-0 bottom-0 left-[9px] w-0.5 bg-fg transition-[width] group-hover:w-1" />
                                    <span className="pointer-events-none absolute top-0 left-[6px] size-0 border-t-[7px] border-t-fg border-x-[5px] border-x-transparent" />
                                </div>
                            ) : (
                                <>
                                    <span className="pointer-events-none absolute top-0 bottom-0 left-[-1px] w-0.5 bg-fg" />
                                    <span className="pointer-events-none absolute top-0 left-[-4px] size-0 border-t-[7px] border-t-fg border-x-[5px] border-x-transparent" />
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <ul className="mt-2.5 flex list-none flex-wrap gap-x-2.5 gap-y-1 p-0">
                {scheduledJobIds.map((jobId) => {
                    const color = jobColor(colors, jobId);
                    const dimmed = selectedJobId !== null && selectedJobId !== jobId;
                    return (
                        <li key={jobId}>
                            <ToggleButton
                                isSelected={selectedJobId === jobId}
                                onChange={() => onSelectJob?.(jobId)}
                                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.75 text-muted-fg text-xs outline-hidden hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1 ${dimmed ? "opacity-40" : ""
                                    }`}
                            >
                                <span
                                    className="size-2.5 shrink-0 rounded-xs ring-1 ring-fg/20 ring-inset"
                                    style={{ background: color.fill }}
                                />
                                <span className="font-bold text-fg">{jobName(jobId)}</span>
                            </ToggleButton>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
