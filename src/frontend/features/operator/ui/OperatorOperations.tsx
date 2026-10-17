import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { HeaderCount } from "@/components/ui/header-count";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { formatDuration, formatOffset } from "@/domains/scheduling/format";
import {
    operationTiming,
    type BreakPeriod,
    type OperationTiming,
    type OperatorOperation,
    type ShiftSegment,
} from "@/features/operator/model/operator-queue";
import { BoltIcon, CheckIcon, ClockIcon, ExclamationTriangleIcon, PauseCircleIcon } from "@heroicons/react/24/outline";

const mins = (value: number) => formatDuration(Math.max(1, Math.round(value)));

const TIMING_BADGE: Record<OperationTiming["kind"], { intent: "info" | "warning" | "danger" | "secondary"; text: string }> = {
    unscheduled: { intent: "secondary", text: "Not started" },
    waiting: { intent: "warning", text: "Waiting" },
    "in-progress": { intent: "info", text: "In progress" },
    delayed: { intent: "danger", text: "Delayed" },
};

function timingText(timing: OperationTiming, operation: OperatorOperation): string {
    switch (timing.kind) {
        case "unscheduled":
            return `Planned for ${mins(operation.endMins - operation.startMins)}`;
        case "waiting":
            return `Starts in ${mins(timing.startsInMins)}`;
        case "in-progress":
            return `${mins(timing.endsInMins)} left in plan`;
        case "delayed":
            return timing.lateByMins < 1 ? "Past its planned end" : `${mins(timing.lateByMins)} past planned end`;
    }
}

/** The one thing to do now, with the one button that moves the queue on. */
export function CurrentOperation({
    operation,
    nowMins,
    onComplete,
    heading = "Current operation",
}: {
    operation: OperatorOperation;
    nowMins: number | null;
    onComplete: () => void;
    heading?: string;
}) {
    const timing = operationTiming(operation, nowMins);
    const badge = TIMING_BADGE[timing.kind];
    const delayed = timing.kind === "delayed";
    return (
        <Card className={delayed ? "border-danger/40 bg-danger-subtle/40" : "border-primary/30 bg-linear-to-br from-primary-subtle/70 to-primary-subtle/20"}>
            <CardContent className="flex flex-col gap-5 pt-6">
                <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-muted-fg text-xs uppercase tracking-[0.08em]">{heading}</span>
                    <Badge intent={badge.intent} className="gap-1.5 px-3 py-1 text-sm">
                        {delayed && <ExclamationTriangleIcon className="size-4" aria-hidden />}
                        {badge.text}
                    </Badge>
                </div>

                <div>
                    <h2 className="font-bold text-4xl leading-tight tracking-tight">{operation.label}</h2>
                    <p className="mt-2 text-lg">
                        {operation.jobLabel}
                        <span className="text-muted-fg"> · Step {operation.opIndex} of {operation.opTotal}</span>
                    </p>
                </div>

                <div className="flex flex-col gap-2">
                    <p className="flex items-center gap-2 text-muted-fg">
                        <ClockIcon className="size-5" aria-hidden />
                        <span className={delayed ? "font-semibold text-danger-subtle-fg" : undefined}>
                            {timingText(timing, operation)}
                        </span>
                    </p>
                    {timing.kind === "in-progress" && (
                        <ProgressBar aria-label="Share of the planned time used" value={timing.progressPct}>
                            <ProgressBarTrack className="min-w-0" />
                        </ProgressBar>
                    )}
                </div>

                <Button size="lg" intent="success" className="h-18 w-full text-xl shadow-sm" onPress={onComplete}>
                    <CheckIcon className="size-6" /> Mark complete
                </Button>
            </CardContent>
        </Card>
    );
}

export function UpcomingOperations({
    segments,
    nowMins,
}: {
    segments: ShiftSegment[];
    nowMins: number | null;
}) {
    // Rows are numbered across stretches, so each stretch starts where the last left off.
    const firstPositions: number[] = [];
    let count = 0;
    for (const segment of segments) {
        firstPositions.push(count + 1);
        if (segment.kind === "work") count += segment.operations.length;
    }
    return (
        <section aria-labelledby="up-next-heading" className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5 px-1">
                <h2 id="up-next-heading" className="font-semibold text-lg">
                    Up next
                    <HeaderCount label={`${count} ${count === 1 ? "operation" : "operations"}`}>
                        {count}
                    </HeaderCount>
                </h2>
            </div>
            {count === 0 ? (
                <Card>
                    <CardContent className="py-6 text-center text-muted-fg text-sm">
                        Nothing else is queued for this machine.
                    </CardContent>
                </Card>
            ) : (
                <ol className="flex flex-col gap-2">
                    {segments.map((segment, segmentIndex) => {
                        if (segment.kind === "break") return <BreakRow key={segment.key} segment={segment} />;
                        if (segment.operations.length === 0) return null;
                        // The first group continues the stretch the current operation is in.
                        const continuing = segmentIndex === 0;
                        return (
                            <li key={segment.key} className="flex flex-col gap-2">
                                <div className="flex items-center gap-2 px-1 pt-1 text-sm">
                                    <BoltIcon className="size-4 text-primary" aria-hidden />
                                    <span className="font-semibold">
                                        {continuing ? "Rest of this stretch" : `Continuous work · ${mins(segment.endMins - segment.startMins)}`}
                                    </span>
                                    <span className="text-muted-fg tabular-nums">
                                        {continuing ? `until ${formatOffset(segment.endMins)}` : `${formatOffset(segment.startMins)} to ${formatOffset(segment.endMins)}`}
                                    </span>
                                </div>
                                <ol className="flex flex-col gap-2 border-primary/30 border-l-2 pl-3">
                                    {segment.operations.map((operation, index) => (
                                        <UpcomingRow
                                            key={operation.key}
                                            operation={operation}
                                            position={firstPositions[segmentIndex] + index}
                                            nowMins={nowMins}
                                        />
                                    ))}
                                </ol>
                            </li>
                        );
                    })}
                </ol>
            )}
        </section>
    );
}

function UpcomingRow({ operation, position, nowMins }: { operation: OperatorOperation; position: number; nowMins: number | null }) {
    const timing = operationTiming(operation, nowMins);
    return (
        <li className="flex items-center gap-4 rounded-xl border bg-overlay px-4 py-3.5 shadow-xs">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary font-bold text-sm tabular-nums">
                {position}
            </span>
            <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-base">{operation.label}</div>
                <div className="truncate text-muted-fg text-sm">
                    {operation.jobLabel} · Step {operation.opIndex} of {operation.opTotal}
                </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge intent={TIMING_BADGE[timing.kind].intent}>{TIMING_BADGE[timing.kind].text}</Badge>
                <span className="text-muted-fg text-xs tabular-nums">{timingText(timing, operation)}</span>
            </div>
        </li>
    );
}

/** Planned idle time, shown as its own entry so it reads as part of the plan. */
function BreakRow({ segment }: { segment: BreakPeriod }) {
    return (
        <li className="flex items-center gap-4 rounded-xl border border-info-subtle-fg/30 border-dashed bg-info-subtle/50 px-4 py-3 text-info-subtle-fg">
            <span className="inline-flex size-9 shrink-0 items-center justify-center">
                <PauseCircleIcon className="size-7" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
                <div className="font-semibold text-base">Break · {mins(segment.endMins - segment.startMins)}</div>
                <div className="text-sm tabular-nums opacity-80">
                    {formatOffset(segment.startMins)} to {formatOffset(segment.endMins)}
                </div>
            </div>
        </li>
    );
}
