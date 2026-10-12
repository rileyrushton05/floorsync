import { Card, CardContent } from "@/components/ui/card";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { formatDuration, formatOffset } from "@/domains/scheduling/format";
import type { ShiftSegment, ShiftStatus } from "@/features/operator/model/operator-queue";
import { BoltIcon, ExclamationTriangleIcon, PauseCircleIcon } from "@heroicons/react/24/outline";

const mins = (value: number) => formatDuration(Math.max(1, Math.round(value)));

/**
 * The headline an operator plans around: how long this break or this stretch of
 * continuous work lasts, and what comes after it.
 */
export function ShiftStatusCard({ status }: { status: ShiftStatus }) {
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
                    <PauseCircleIcon className="size-5 shrink-0" aria-hidden />
                    <div className="text-sm">
                        {status.nextBreak ? (
                            <>
                                <div className="font-semibold">Next break: {mins(status.nextBreak.endMins - status.nextBreak.startMins)}</div>
                                <div className="tabular-nums">
                                    {formatOffset(status.nextBreak.startMins)} to {formatOffset(status.nextBreak.endMins)}
                                </div>
                            </>
                        ) : (
                            <div className="font-semibold">No more breaks after this stretch</div>
                        )}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

/**
 * The whole machine's plan as one bar: work stretches and breaks to scale, with
 * a marker at the simulation clock.
 */
export function ShiftStrip({ segments, nowMins }: { segments: ShiftSegment[]; nowMins: number | null }) {
    if (segments.length === 0) return null;
    const startMins = segments[0].startMins;
    const endMins = segments[segments.length - 1].endMins;
    const span = endMins - startMins;
    if (span <= 0) return null;
    const nowPct = nowMins === null ? null : ((nowMins - startMins) / span) * 100;

    return (
        <div className="flex flex-col gap-1.5">
            <div className="relative flex h-4 gap-0.5" role="img" aria-label={stripLabel(segments)}>
                {segments.map((segment) => (
                    <div
                        key={segment.key}
                        title={`${segment.kind === "work" ? "Work" : "Break"} · ${mins(segment.endMins - segment.startMins)} · ${formatOffset(segment.startMins)} to ${formatOffset(segment.endMins)}`}
                        className={
                            segment.kind === "work"
                                ? "min-w-1 rounded-sm bg-primary"
                                : "min-w-1 rounded-sm border border-info-subtle-fg/40 border-dashed bg-info-subtle"
                        }
                        style={{ flexGrow: segment.endMins - segment.startMins, flexBasis: 0 }}
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
            <div className="flex justify-between text-muted-fg text-xs tabular-nums">
                <span>{formatOffset(startMins)}</span>
                <span className="flex items-center gap-3">
                    <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-primary" /> Work</span>
                    <span className="flex items-center gap-1">
                        <span className="size-2.5 rounded-sm border border-info-subtle-fg/40 border-dashed bg-info-subtle" /> Break
                    </span>
                </span>
                <span>{formatOffset(endMins)}</span>
            </div>
        </div>
    );
}

function stripLabel(segments: ShiftSegment[]): string {
    return segments
        .map((segment) => `${segment.kind === "work" ? "Work" : "Break"} ${mins(segment.endMins - segment.startMins)}`)
        .join(", then ");
}
