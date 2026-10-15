import { Card, CardContent } from "@/components/ui/card";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { formatDuration, formatOffset } from "@/domains/scheduling/format";
import type { ShiftSegment, ShiftStatus } from "@/features/operator/model/operator-queue";
import { BoltIcon, ClockIcon, ExclamationTriangleIcon, FlagIcon, PauseCircleIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";

const mins = (value: number) => formatDuration(Math.max(1, Math.round(value)));

/**
 * The headline an operator plans around: how long this break or this stretch of
 * continuous work lasts, and what comes after it.
 */
export function ShiftStatusCard({ status }: { status: ShiftStatus }) {
    if (status.kind === "not-started") {
        return (
            <Card className="border-info-subtle-fg/30 bg-info-subtle/60">
                <CardContent className="flex flex-col gap-4 pt-6">
                    <div className="flex items-center gap-2 font-bold text-info-subtle-fg text-xs uppercase tracking-[0.08em]">
                        <ClockIcon className="size-5" aria-hidden />
                        Not started yet
                    </div>
                    <div>
                        <p className="font-bold text-4xl tabular-nums leading-tight tracking-tight">
                            Starts at {formatOffset(status.startsAtMins)}
                        </p>
                        <p className="mt-2 text-lg text-muted-fg">
                            Nothing to do for {mins(status.leftMins)}.
                        </p>
                    </div>
                </CardContent>
            </Card>
        );
    }

    if (status.kind === "break") {
        const finishedEarly = status.planned && status.leftMins > status.lengthMins;
        return (
            <Card className="border-info-subtle-fg/30 bg-info-subtle/60">
                <CardContent className="flex flex-col gap-4 pt-6">
                    <div className="flex items-center gap-2 font-bold text-info-subtle-fg text-xs uppercase tracking-[0.08em]">
                        <PauseCircleIcon className="size-5" aria-hidden />
                        {status.planned ? "On a break" : "Ahead of plan"}
                    </div>
                    <div>
                        <p className="font-bold text-4xl tabular-nums leading-tight tracking-tight">
                            {mins(status.leftMins)} <span className="font-semibold text-2xl text-muted-fg">left</span>
                        </p>
                        <p className="mt-2 text-lg">
                            {status.planned
                                ? finishedEarly
                                    ? `You finished early, so this ${mins(status.lengthMins)} break runs longer.`
                                    : `Break of ${mins(status.lengthMins)} in total.`
                                : "The next operation is not due yet."}
                            <span className="text-muted-fg"> Work resumes at {formatOffset(status.resumesAtMins)}.</span>
                        </p>
                    </div>
                    {status.planned && !finishedEarly && (
                        <ProgressBar aria-label="Share of the break used" value={status.progressPct}>
                            <ProgressBarTrack className="min-w-0 [--progress-content-bg:var(--color-info-subtle-fg)]" />
                        </ProgressBar>
                    )}
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className={status.behind ? "border-danger/40 bg-danger-subtle/40" : undefined}>
            <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-6">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-primary-subtle-fg">
                        {status.behind ? <ExclamationTriangleIcon className="size-5" aria-hidden /> : <BoltIcon className="size-5" aria-hidden />}
                    </span>
                    <div className="min-w-0">
                        <div className="font-bold text-muted-fg text-xs uppercase tracking-[0.08em]">Continuous work</div>
                        <div className="font-bold text-2xl tabular-nums">
                            {status.behind
                                ? "Running behind plan"
                                : status.leftMins < 1
                                    ? "Ending now"
                                    : `${mins(status.leftMins)} left`}
                        </div>
                        <div className="text-muted-fg text-sm tabular-nums">
                            {mins(status.stretchLengthMins)} stretch, planned to end at {formatOffset(status.stretchEndMins)}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-3 rounded-lg bg-info-subtle/60 px-4 py-2.5 text-info-subtle-fg">
                    {status.nextBreak
                        ? <PauseCircleIcon className="size-5 shrink-0" aria-hidden />
                        : <FlagIcon className="size-5 shrink-0" aria-hidden />}
                    <div className="text-sm">
                        {status.nextBreak ? (
                            <>
                                <div className="font-semibold">Next break: {mins(status.nextBreak.endMins - status.nextBreak.startMins)}</div>
                                <div className="tabular-nums">
                                    {formatOffset(status.nextBreak.startMins)} to {formatOffset(status.nextBreak.endMins)}
                                </div>
                            </>
                        ) : (
                            <div className="font-semibold">Final stretch</div>
                        )}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

/** Rough rendered width of a "T+12:30" label at text-xs, plus breathing room. */
const MARK_LABEL_PX = 46;
const MARK_ROWS = 2;

interface StripMark {
    key: string;
    mins: number;
    pct: number;
    /** Which side of the point the label sits on, so a break's two times point away from each other. */
    side: "before" | "after";
    row: number | null;
}

/**
 * The whole machine's plan as one bar: work stretches and breaks to scale, with
 * a marker at the simulation clock and the time each break starts and ends.
 */
export function ShiftStrip({ segments, nowMins }: { segments: ShiftSegment[]; nowMins: number | null }) {
    const ref = useRef<HTMLDivElement>(null);
    const [widthPx, setWidthPx] = useState(600);
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => setWidthPx(entry.contentRect.width));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const startMins = segments[0]?.startMins ?? 0;
    const endMins = segments[segments.length - 1]?.endMins ?? 0;
    const span = endMins - startMins;
    const marks = useMemo(
        () => (span > 0 ? placeMarks(segments, startMins, span, widthPx) : []),
        [segments, startMins, span, widthPx],
    );
    if (segments.length === 0 || span <= 0) return null;
    const pctOf = (value: number) => ((value - startMins) / span) * 100;
    const nowPct = nowMins === null ? null : pctOf(nowMins);
    const rows = Math.max(1, ...marks.map((mark) => (mark.row ?? 0) + 1));

    return (
        <div className="flex flex-col gap-1.5" ref={ref}>
            <div className="relative h-4" role="img" aria-label={stripLabel(segments)}>
                {segments.map((segment) => (
                    <div
                        key={segment.key}
                        title={`${segment.kind === "work" ? "Work" : "Break"} · ${mins(segment.endMins - segment.startMins)} · ${formatOffset(segment.startMins)} to ${formatOffset(segment.endMins)}`}
                        className={
                            segment.kind === "work"
                                ? "absolute inset-y-0 min-w-0.5 rounded-sm bg-primary"
                                : "absolute inset-y-0 min-w-0.5 rounded-sm border border-info-subtle-fg/40 border-dashed bg-info-subtle"
                        }
                        style={{ left: `${pctOf(segment.startMins)}%`, width: `${((segment.endMins - segment.startMins) / span) * 100}%` }}
                    />
                ))}
                {nowPct !== null && nowPct >= 0 && nowPct <= 100 && (
                    <div
                        className="-translate-x-1/2 -top-1 -bottom-1 absolute w-0.5 rounded-full bg-fg"
                        style={{ left: `${nowPct}%` }}
                        aria-hidden
                    />
                )}
            </div>
            <div className="relative text-muted-fg text-xs tabular-nums" style={{ height: `${rows * 1.25 + 0.375}rem` }} aria-hidden>
                {marks.map((mark) => (
                    <div key={mark.key} className="absolute top-0" style={{ left: `${mark.pct}%` }}>
                        <div
                            className="-translate-x-1/2 absolute top-0 w-px bg-border"
                            style={{ height: mark.row === null ? "0.375rem" : `${mark.row * 1.25 + 0.5}rem` }}
                        />
                        {mark.row !== null && (
                            <span
                                className={`absolute whitespace-nowrap leading-5 ${mark.side === "before" ? "right-0 pr-0.5" : "left-0 pl-0.5"}`}
                                style={{ top: `${mark.row * 1.25 + 0.375}rem` }}
                            >
                                {formatOffset(mark.mins)}
                            </span>
                        )}
                    </div>
                ))}
            </div>
            <div className="flex justify-end gap-3 text-muted-fg text-xs">
                <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-primary" /> Work</span>
                <span className="flex items-center gap-1">
                    <span className="size-2.5 rounded-sm border border-info-subtle-fg/40 border-dashed bg-info-subtle" /> Break
                </span>
            </div>
        </div>
    );
}

/**
 * Times to show under the bar: the plan's start and end, then each break's start
 * and end. Each label takes the first row where it does not collide with one
 * already placed; one that fits nowhere keeps its tick but drops its text.
 */
function placeMarks(segments: ShiftSegment[], startMins: number, span: number, widthPx: number): StripMark[] {
    const labelPct = (MARK_LABEL_PX / Math.max(widthPx, 1)) * 100;
    const pctOf = (value: number) => ((value - startMins) / span) * 100;
    const marks: StripMark[] = [
        { key: "start", mins: startMins, pct: 0, side: "after", row: null },
        { key: "end", mins: startMins + span, pct: 100, side: "before", row: null },
    ];
    for (const segment of segments) {
        if (segment.kind !== "break") continue;
        marks.push(
            { key: `${segment.key}:start`, mins: segment.startMins, pct: pctOf(segment.startMins), side: "before", row: null },
            { key: `${segment.key}:end`, mins: segment.endMins, pct: pctOf(segment.endMins), side: "after", row: null },
        );
    }

    const taken: Array<Array<[number, number]>> = Array.from({ length: MARK_ROWS }, () => []);
    for (const mark of marks) {
        const from = mark.side === "before" ? mark.pct - labelPct : mark.pct;
        const to = from + labelPct;
        const row = taken.findIndex((placed) => placed.every(([left, right]) => to <= left || from >= right));
        if (row < 0) continue;
        taken[row].push([from, to]);
        mark.row = row;
    }
    return marks;
}

function stripLabel(segments: ShiftSegment[]): string {
    return segments
        .map((segment) => `${segment.kind === "work" ? "Work" : "Break"} ${mins(segment.endMins - segment.startMins)}`)
        .join(", then ");
}
