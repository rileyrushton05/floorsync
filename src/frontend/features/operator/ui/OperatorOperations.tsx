import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { formatDuration } from "@/domains/scheduling/format";
import {
    operationTiming,
    type OperationTiming,
    type OperatorOperation,
} from "@/features/operator/model/operator-queue";
import { CheckIcon, ClockIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";

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
}: {
    operation: OperatorOperation;
    nowMins: number | null;
    onComplete: () => void;
}) {
    const timing = operationTiming(operation, nowMins);
    const badge = TIMING_BADGE[timing.kind];
    const delayed = timing.kind === "delayed";
    return (
        <Card className={delayed ? "border-danger/40 bg-danger-subtle/40" : "border-primary/30 bg-linear-to-br from-primary-subtle/70 to-primary-subtle/20"}>
            <CardContent className="flex flex-col gap-5 pt-6">
                <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-muted-fg text-xs uppercase tracking-[0.08em]">Current operation</span>
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
    operations,
    nowMins,
}: {
    operations: OperatorOperation[];
    nowMins: number | null;
}) {
    return (
        <section aria-labelledby="up-next-heading" className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5 px-1">
                <h2 id="up-next-heading" className="font-semibold text-lg">Up next</h2>
                <Badge intent="secondary">{operations.length}</Badge>
            </div>
            {operations.length === 0 ? (
                <Card>
                    <CardContent className="py-6 text-center text-muted-fg text-sm">
                        Nothing else is queued for this machine.
                    </CardContent>
                </Card>
            ) : (
                <ol className="flex flex-col gap-2">
                    {operations.map((operation, index) => {
                        const timing = operationTiming(operation, nowMins);
                        return (
                            <li
                                key={operation.key}
                                className="flex items-center gap-4 rounded-xl border bg-overlay px-4 py-3.5 shadow-xs"
                            >
                                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary font-bold text-sm tabular-nums">
                                    {index + 1}
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
                    })}
                </ol>
            )}
        </section>
    );
}
