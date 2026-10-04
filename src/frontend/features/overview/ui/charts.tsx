"use client";

import { useState } from "react";

/**
 * Two small charts for the overview, drawn by hand rather than through a chart
 * library: they only need a ring and a row of bars, and drawing them keeps
 * the colours on the theme's own `--chart-*` tokens.
 *
 * Colours come from the theme's categorical slots in fixed order (validated
 * with the dataviz checker: CVD ΔE 9.1 worst adjacent). Two of those slots sit
 * under 3:1 against the card, which is why every segment and bar also carries
 * a visible label or count; nothing is identified by colour alone.
 */

export interface DonutSegment {
    key: string;
    label: string;
    value: number;
    color: string;
}

const SIZE = 160;
const STROKE = 22;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Surface gap between segments, in px along the ring. */
const GAP = 3;

export function DonutChart({
    segments,
    totalLabel,
    ariaLabel,
}: {
    segments: DonutSegment[];
    totalLabel: string;
    ariaLabel: string;
}) {
    const [hovered, setHovered] = useState<string | null>(null);
    const total = segments.reduce((sum, segment) => sum + segment.value, 0);
    const visible = segments.filter((segment) => segment.value > 0);
    const focus = segments.find((segment) => segment.key === hovered) ?? null;

    const lengths = visible.map((segment) => (segment.value / total) * CIRCUMFERENCE);
    const arcs = visible.map((segment, i) => ({
        ...segment,
        dash: Math.max(0, lengths[i] - (visible.length > 1 ? GAP : 0)),
        offset: lengths.slice(0, i).reduce((sum, length) => sum + length, 0),
    }));

    return (
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
            <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
                <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90" role="img" aria-label={ariaLabel}>
                    <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-muted" />
                    {arcs.map((arc) => (
                        <circle
                            key={arc.key}
                            cx={SIZE / 2}
                            cy={SIZE / 2}
                            r={RADIUS}
                            fill="none"
                            stroke={arc.color}
                            strokeWidth={hovered === arc.key ? STROKE + 4 : STROKE}
                            strokeDasharray={`${arc.dash} ${CIRCUMFERENCE - arc.dash}`}
                            strokeDashoffset={-arc.offset}
                            className="cursor-default transition-[stroke-width,opacity]"
                            opacity={hovered === null || hovered === arc.key ? 1 : 0.35}
                            onPointerEnter={() => setHovered(arc.key)}
                            onPointerLeave={() => setHovered(null)}
                        />
                    ))}
                </svg>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="font-bold text-2xl tabular-nums">{focus ? focus.value : total}</span>
                    <span className="text-muted-fg text-xs">{focus ? focus.label : totalLabel}</span>
                </div>
            </div>
            <ul className="grid w-full gap-1.5 text-sm">
                {segments.map((segment) => (
                    <li
                        key={segment.key}
                        className={`flex items-center gap-2 rounded-md px-2 py-1 transition ${hovered === segment.key ? "bg-muted" : ""}`}
                        onPointerEnter={() => setHovered(segment.key)}
                        onPointerLeave={() => setHovered(null)}
                    >
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: segment.color }} />
                        <span className="flex-1">{segment.label}</span>
                        <span className="font-semibold tabular-nums">{segment.value}</span>
                        <span className="w-10 text-right text-muted-fg text-xs tabular-nums">
                            {total === 0 ? "0%" : `${Math.round((segment.value / total) * 100)}%`}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export interface BarDatum {
    key: string;
    label: string;
    value: number;
    color: string;
    /** The tooltip's text; defaults to the label and formatted value. */
    detail?: string;
}

/**
 * Vertical bars on a single scale. `max` pins the top of the scale (e.g. 100
 * for percentages); otherwise it rounds up from the largest value.
 */
export function BarChart({
    data,
    max,
    format,
    ariaLabel,
}: {
    data: BarDatum[];
    max?: number;
    format: (value: number) => string;
    ariaLabel: string;
}) {
    const [hovered, setHovered] = useState<string | null>(null);
    const top = max ?? niceMax(Math.max(0, ...data.map((datum) => datum.value)));
    const ticks = [top, top / 2, 0];

    return (
        <div role="img" aria-label={ariaLabel} className="flex h-52 gap-2">
            <div className="flex flex-col justify-between pb-6 text-right text-[11px] text-muted-fg tabular-nums">
                {ticks.map((tick) => (
                    <span key={tick}>{format(tick)}</span>
                ))}
            </div>
            <div className="relative flex min-w-0 flex-1 flex-col">
                <div className="pointer-events-none absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between">
                    {ticks.map((tick) => (
                        <div key={tick} className={`border-t ${tick === 0 ? "border-border" : "border-dashed border-border/60"}`} />
                    ))}
                </div>
                <div className="relative flex flex-1 items-end gap-[2px] sm:gap-2">
                    {data.map((datum) => {
                        const height = top === 0 ? 0 : Math.min(100, (datum.value / top) * 100);
                        const active = hovered === datum.key;
                        return (
                            <div
                                key={datum.key}
                                className="relative flex h-full min-w-0 flex-1 cursor-default items-end justify-center"
                                onPointerEnter={() => setHovered(datum.key)}
                                onPointerLeave={() => setHovered(null)}
                            >
                                {active && (
                                    <div
                                        className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border bg-overlay px-2 py-1 text-overlay-fg text-xs shadow-md"
                                        style={{ bottom: `calc(${height}% + 6px)` }}
                                    >
                                        {datum.detail ?? `${datum.label}: ${format(datum.value)}`}
                                    </div>
                                )}
                                <div
                                    className="w-full max-w-10 rounded-t-[4px] transition-opacity"
                                    style={{
                                        height: `${height}%`,
                                        minHeight: datum.value > 0 ? 2 : 0,
                                        background: datum.color,
                                        opacity: hovered === null || active ? 1 : 0.45,
                                    }}
                                />
                            </div>
                        );
                    })}
                </div>
                <div className="flex h-6 gap-[2px] sm:gap-2">
                    {data.map((datum) => (
                        <span key={datum.key} className="min-w-0 flex-1 truncate pt-1.5 text-center text-[11px] text-muted-fg" title={datum.label}>
                            {datum.label}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
}

function niceMax(value: number): number {
    if (value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
    return step * magnitude;
}
