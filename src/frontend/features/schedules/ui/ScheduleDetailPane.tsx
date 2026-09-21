import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { Separator } from "@/components/ui/separator";
import { buildJobColors, type JobColor } from "@/domains/scheduling/colors";
import { formatDuration } from "@/domains/scheduling/format";
import type { TimelinePlan } from "@/domains/scheduling/timeline";
import { GanttChart } from "@/domains/scheduling/ui/GanttChart";
import { TimelineNavigator, useTimelineZoom } from "@/domains/scheduling/ui/TimelineNavigator";
import { useState } from "react";
import { formatCreatedAt, shortScheduleId, type ScheduleRow } from "../model/archive";
import { ScheduleStatusBadge } from "./ScheduleStatusBadge";

/**
 * Right column of the Schedules page: everything known about one past run,
 * read-only apart from lifecycle transitions and deleting a draft. The plan preview and
 * machine-load bars are drawn exactly as the Planner page draws them, from the
 * same `timelineToPlan` translation — the Gantt is static here, a record of
 * the run rather than a thing to scrub.
 */
export function ScheduleDetailPane({
    schedule,
    plan,
    updating,
    deleting,
    onConfirm,
    onWithdraw,
    onRestore,
    onDelete,
}: {
    schedule: ScheduleRow;
    plan: TimelinePlan | null;
    updating: boolean;
    deleting: boolean;
    onConfirm: () => void;
    onWithdraw: () => void;
    onRestore: () => void;
    onDelete: () => void;
}) {
    const summary = plan?.schedule ?? null;
    const machineName = (id: string) => plan?.machines.find((machine) => machine.id === id)?.name ?? id;
    const colors = buildJobColors(plan?.jobs ?? []);
    const machinesUsed = summary
        ? summary.machineLoad.filter((load) => load.busyMins > 0).length
        : 0;

    return (
        <Card className="min-w-0">
            <CardHeader className="gap-1">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-muted-fg text-xs">
                            Schedules › {shortScheduleId(schedule.id)}
                        </p>
                        <div className="flex items-center gap-3">
                            <CardTitle className="truncate text-2xl">{shortScheduleId(schedule.id)}</CardTitle>
                            <ScheduleStatusBadge status={schedule.status} />
                        </div>
                        <p className="text-muted-fg text-xs">{shortScheduleId(schedule.id)}</p>
                    </div>
                    {summary && (
                        <Link
                            href={`/manager/simulation?schedule=${encodeURIComponent(schedule.id)}`}
                            className={buttonStyles({ intent: "success", size: "sm" })}
                        >
                            Open in simulation →
                        </Link>
                    )}
                </div>
                <p className="text-muted-fg text-sm">
                    {schedule.strategy} · Generated {formatCreatedAt(schedule.createdAt)}
                    {summary && (
                        <>
                            {" · "}
                            {summary.ops.length} operations · {plan!.jobs.length} jobs
                        </>
                    )}
                </p>
            </CardHeader>
            <CardContent>
                <Separator className="mb-4" />

                {/* ===== METADATA ===== */}
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                    <Metadata label="Strategy" value={schedule.strategy} />
                    <Metadata label="Jobs" value={summary ? plan!.jobs.length : "—"} />
                    <Metadata label="Machines used" value={summary ? machinesUsed : "—"} />
                    <Metadata
                        label="Makespan"
                        value={schedule.makespanMins === null ? "—" : formatDuration(schedule.makespanMins)}
                    />
                    <Metadata label="Generated at" value={formatCreatedAt(schedule.createdAt)} />
                    <Metadata
                        label="Confirmed at"
                        value={schedule.confirmedAt === null ? "—" : formatCreatedAt(schedule.confirmedAt)}
                    />
                    <Metadata label="Confirmed by" value={schedule.confirmedByUserId ?? "—"} />
                </dl>

                <Separator className="my-4" />

                {/* ===== PLAN PREVIEW (interactive Gantt) ===== */}
                {summary && plan ? (
                    <PlanPreview key={schedule.id} plan={plan} colors={colors} />
                ) : (
                    <p className="mt-2 text-muted-fg text-sm">
                        The timeline for this run could not be read, so the plan cannot be drawn.
                    </p>
                )}

                <Separator className="my-4" />

                {/* ===== MACHINE LOAD ===== */}
                <h3 className="font-semibold text-sm">Machine load</h3>
                {summary ? (
                    <ul className="mt-2 space-y-2">
                        {summary.machineLoad
                            .filter((load) => load.busyMins > 0)
                            .map((load) => (
                                <li key={load.machineId} className="flex items-center gap-2.5">
                                    <span className="w-24 shrink-0 truncate text-sm">
                                        {machineName(load.machineId)}
                                    </span>
                                    <ProgressBar
                                        aria-label={`${machineName(load.machineId)} utilisation`}
                                        value={load.utilisationPct}
                                        className="flex-1"
                                    >
                                        <ProgressBarTrack className="min-w-0" />
                                    </ProgressBar>
                                    <span className="w-9 shrink-0 text-right text-muted-fg text-xs tabular-nums">
                                        {load.utilisationPct}%
                                    </span>
                                </li>
                            ))}
                    </ul>
                ) : (
                    <p className="mt-2 text-muted-fg text-sm">
                        The timeline for this run could not be read, so utilisation is unavailable.
                    </p>
                )}

                <Separator className="my-4" />

                {/* ===== FOOTER ===== */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-muted-fg text-sm">
                        {summary
                            ? `${summary.ops.length} operations · ${plan!.jobs.length} jobs · makespan ${formatDuration(summary.makespanMins)}`
                            : `${schedule.opsCount ?? "—"} operations · makespan ${schedule.makespanMins === null ? "—" : formatDuration(schedule.makespanMins)}`}
                    </span>
                    <span className="flex items-center gap-2">
                        {schedule.status === "draft" && (
                            <Button intent="success" size="sm" isPending={updating} onPress={onConfirm}>
                                Confirm schedule
                            </Button>
                        )}
                        {schedule.status === "confirmed" && (
                            <Button intent="outline" size="sm" isPending={updating} onPress={onWithdraw}>
                                Withdraw schedule
                            </Button>
                        )}
                        {schedule.status === "discarded" && (
                            <Button intent="success" size="sm" isPending={updating} onPress={onRestore}>
                                Restore schedule
                            </Button>
                        )}
                        {schedule.status === "draft" && (
                            <Button
                                intent="danger"
                                size="sm"
                                isPending={deleting}
                                onPress={onDelete}
                            >
                                Delete schedule
                            </Button>
                        )}
                    </span>
                </div>
            </CardContent>
        </Card>
    );
}

/**
 * The plan preview: the same interactive Gantt the Simulation page draws,
 * minus the clock. Click a block or a job key to highlight that job across
 * the chart; Alt + scroll, Alt + +/-, or the navigator slider zooms the
 * timeline. Mounted with `key={schedule.id}` so picking another schedule
 * starts from a clean highlight and a fit-everything zoom level.
 */
function PlanPreview({
    plan,
    colors,
}: {
    plan: TimelinePlan;
    colors: Map<string, JobColor>;
}) {
    const summary = plan.schedule;
    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);
    // A non-finite makespan (a refetch handing back a partial payload, say)
    // would poison every zoom computation downstream with NaN, so it is
    // normalised to 0 here — the hook's own fallbacks take it from there.
    const makespanMins = Number.isFinite(summary.makespanMins) ? summary.makespanMins : 0;
    const timelineZoom = useTimelineZoom(makespanMins);

    return (
        <div className="mt-2">
            <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="font-semibold text-sm">Plan preview</h3>
                {/* The navigator's slider sizes itself to its parent (`w-full`),
                    and on the Simulation page a `flex-1` header slot gives it a
                    definite width. This header is content-sized, so an explicit
                    width here keeps the track from collapsing to zero. */}
                <TimelineNavigator controls={timelineZoom} className="w-64" />
            </div>
            <GanttChart
                machines={plan.machines}
                jobs={plan.jobs}
                schedule={summary}
                colors={colors}
                mode="plan"
                selectedJobId={highlightedJobId}
                zoom={timelineZoom}
                onSelectJob={(jobId) =>
                    setHighlightedJobId((previous) => (previous === jobId ? null : jobId))
                }
            />
        </div>
    );
}

function Metadata({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="rounded-lg border bg-muted p-3">
            <dd className="truncate font-semibold text-sm">{value}</dd>
            <dt className="text-muted-fg text-xs">{label}</dt>
        </div>
    );
}
