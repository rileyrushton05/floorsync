import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { Note } from "@/components/ui/note";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { Separator } from "@/components/ui/separator";
import { buildJobColors, type JobColor } from "@/domains/scheduling/colors";
import { formatDuration } from "@/domains/scheduling/format";
import type { TimelinePlan } from "@/domains/scheduling/timeline";
import { GanttChart } from "@/domains/scheduling/ui/GanttChart";
import { useTimelineZoom } from "@/domains/scheduling/ui/useTimelineZoom";
import { PencilSquareIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import {
    formatCreatedAt,
    scheduleDisplayName,
    shortScheduleId,
    strategyLabel,
    type ScheduleRow,
} from "../model/archive";
import { ScheduleStatusBadge } from "./ScheduleStatusBadge";

/**
 * Right column of the Schedules page: everything known about one schedule,
 * read-only apart from its name, lifecycle transitions and deleting a draft.
 * The plan preview and machine-load bars are drawn exactly as the Planner page
 * draws them, from the same `timelineToPlan` translation.
 */
export function ScheduleDetailPane({
    schedule,
    plan,
    planLoading,
    planError,
    confirmedByLabel,
    updating,
    deleting,
    onRename,
    onConfirm,
    onWithdraw,
    onRestore,
    onDelete,
}: {
    schedule: ScheduleRow;
    plan: TimelinePlan | null;
    planLoading: boolean;
    planError: string | null;
    /** Who confirmed it, already resolved to something a person can read. */
    confirmedByLabel: string;
    updating: boolean;
    deleting: boolean;
    onRename: () => void;
    onConfirm: () => void;
    onWithdraw: () => void;
    onRestore: () => void;
    onDelete: () => void;
}) {
    const summary = plan?.schedule ?? null;
    const machineName = (id: string) => plan?.machines.find((machine) => machine.id === id)?.name ?? id;
    const colors = useMemo(() => buildJobColors(plan?.jobs ?? []), [plan]);
    const busyLoads = summary?.machineLoad.filter((load) => load.busyMins > 0) ?? [];
    const busy = updating || deleting;
    const unavailable = planLoading
        ? "Reading this schedule's timeline…"
        : planError
            ? `The timeline for this schedule could not be read: ${planError}`
            : "The timeline for this schedule could not be read.";

    return (
        <Card className="min-w-0">
            <CardHeader className="gap-1">
                <div className="flex min-w-0 items-center gap-3">
                    <CardTitle className={`truncate text-2xl ${schedule.name ? "" : "text-muted-fg italic"}`}>
                        {scheduleDisplayName(schedule)}
                    </CardTitle>
                    <ScheduleStatusBadge status={schedule.status} />
                </div>
                <p className="text-muted-fg text-sm">
                    {strategyLabel(schedule.strategy)} · Generated {formatCreatedAt(schedule.createdAt)}
                    {" · "}
                    <span title={schedule.id}>ID {shortScheduleId(schedule.id)}</span>
                </p>
                {/* Actions live in the header, not under the chart, so they are
                    on screen as soon as a schedule is opened. */}
                <CardAction className="flex flex-wrap items-center justify-end gap-2">
                    <Button intent="outline" size="sm" onPress={onRename} isDisabled={busy}>
                        <PencilSquareIcon /> {schedule.name ? "Rename" : "Name"}
                    </Button>
                    {schedule.status === "draft" && (
                        <>
                            <Button intent="danger" size="sm" isPending={deleting} isDisabled={updating} onPress={onDelete}>
                                Delete draft
                            </Button>
                            <Link
                                href={`/manager/planner?schedule=${encodeURIComponent(schedule.id)}`}
                                className={buttonStyles({ intent: "outline", size: "sm" })}
                            >
                                Open in planner
                            </Link>
                            <Button intent="success" size="sm" isPending={updating} isDisabled={deleting} onPress={onConfirm}>
                                Confirm schedule
                            </Button>
                        </>
                    )}
                    {schedule.status === "confirmed" && (
                        <>
                            <Button intent="outline" size="sm" isPending={updating} onPress={onWithdraw}>
                                Withdraw
                            </Button>
                            <Link
                                href={`/manager/simulation?schedule=${encodeURIComponent(schedule.id)}`}
                                className={buttonStyles({ intent: "success", size: "sm" })}
                            >
                                <PlayIcon className="size-4" /> Run in simulation
                            </Link>
                        </>
                    )}
                    {schedule.status === "discarded" && (
                        <Button intent="success" size="sm" isPending={updating} onPress={onRestore}>
                            Restore schedule
                        </Button>
                    )}
                </CardAction>
            </CardHeader>
            <CardContent>
                {schedule.status === "draft" && (
                    <Note intent="warning" className="mb-4">
                        <strong>This schedule has not been saved.</strong> Open it in the Planner to name
                        and save it, or confirm it here. Only confirmed schedules can be run in the
                        simulation.
                    </Note>
                )}
                {schedule.status === "discarded" && (
                    <Note intent="default" className="mb-4">
                        This schedule was withdrawn. Restore it to make it the plan again and run it
                        in the simulation.
                    </Note>
                )}

                {/* ===== METADATA ===== */}
                <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    <Metadata label="Strategy" value={strategyLabel(schedule.strategy)} />
                    <Metadata label="Jobs" value={plan ? plan.jobs.length : "–"} />
                    <Metadata label="Machines used" value={summary ? busyLoads.length : "–"} />
                    <Metadata
                        label="Makespan"
                        value={schedule.makespanMins === null ? "–" : formatDuration(schedule.makespanMins)}
                    />
                    <Metadata label="Operations" value={summary?.ops.length ?? schedule.opsCount ?? "–"} />
                    <Metadata label="Generated at" value={formatCreatedAt(schedule.createdAt)} />
                    <Metadata
                        label="Confirmed at"
                        value={schedule.confirmedAt === null ? "–" : formatCreatedAt(schedule.confirmedAt)}
                    />
                    <Metadata label="Confirmed by" value={confirmedByLabel} />
                </dl>

                <Separator className="my-4" />

                {/* ===== PLAN PREVIEW ===== */}
                {summary && plan ? (
                    <PlanPreview key={schedule.id} plan={plan} colors={colors} />
                ) : (
                    <p className="mt-2 text-muted-fg text-sm" role={planLoading ? "status" : undefined}>
                        {unavailable}
                    </p>
                )}

                <Separator className="my-4" />

                {/* ===== MACHINE LOAD ===== */}
                <h3 className="font-semibold text-sm">Machine load</h3>
                {summary ? (
                    // A compact grid rather than one row per machine, so a large
                    // floor does not push the page far below the chart.
                    <ul className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 2xl:grid-cols-3">
                        {busyLoads.map((load) => (
                            <li key={load.machineId} className="flex items-center gap-2">
                                <span className="w-20 shrink-0 truncate text-xs" title={machineName(load.machineId)}>
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
                    <p className="mt-2 text-muted-fg text-sm">{planLoading ? "–" : "Utilisation is unavailable."}</p>
                )}

            </CardContent>
        </Card>
    );
}

/**
 * The plan preview: the same interactive Gantt the Simulation page draws,
 * minus the clock. Click a block or a job key to highlight that job across
 * the chart; scrolling over it (or Alt + +/-) zooms the timeline. Mounted
 * with `key={schedule.id}` so picking another schedule starts from a clean
 * highlight and a fit-everything zoom level.
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
    // normalised to 0 here; the hook's own fallbacks take it from there.
    const makespanMins = Number.isFinite(summary.makespanMins) ? summary.makespanMins : 0;
    const timelineZoom = useTimelineZoom(makespanMins);

    return (
        <div className="mt-2">
            <h3 className="mb-3 font-semibold text-sm">Plan preview</h3>
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
        <div className="flex flex-col-reverse rounded-lg border bg-muted px-3 py-2">
            <dt className="text-muted-fg text-xs">{label}</dt>
            <dd className="truncate font-semibold text-sm">{value}</dd>
        </div>
    );
}
