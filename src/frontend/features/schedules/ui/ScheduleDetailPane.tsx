import { PencilSquareIcon } from "@heroicons/react/24/outline";
import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { Separator } from "@/components/ui/separator";
import { GanttChart } from "@/domains/scheduling/ui/GanttChart";
import { buildJobColors } from "@/domains/scheduling/colors";
import { formatDuration } from "@/domains/scheduling/format";
import type { TimelinePlan } from "@/domains/scheduling/timeline";
import { formatCreatedAt, shortScheduleId, type ScheduleRow } from "../model/archive";
import { ScheduleStatusBadge } from "./ScheduleStatusBadge";

/**
 * Right column of the Schedules page: everything known about one past run,
 * read-only apart from renaming, archiving and deleting. The plan preview and
 * machine-load bars are drawn exactly as the Planner page draws them, from the
 * same `timelineToPlan` translation — the Gantt is static here, a record of
 * the run rather than a thing to scrub.
 */
export function ScheduleDetailPane({
    schedule,
    plan,
    archiving,
    deleting,
    canArchive,
    onToggleArchive,
    onRename,
    onDelete,
}: {
    schedule: ScheduleRow;
    plan: TimelinePlan | null;
    archiving: boolean;
    deleting: boolean;
    /** Another Confirmed schedule exists that can take over on the floor. */
    canArchive: boolean;
    onToggleArchive: () => void;
    onRename: () => void;
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
                            <CardTitle className="truncate text-2xl">
                                {schedule.name?.trim() || shortScheduleId(schedule.id)}
                            </CardTitle>
                            <ScheduleStatusBadge status={schedule.status} />
                            <Button
                                intent="outline"
                                size="sm"
                                aria-label="Rename schedule"
                                onPress={onRename}
                            >
                                <PencilSquareIcon /> Rename
                            </Button>
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
                </dl>

                <Separator className="my-4" />

                {/* ===== PLAN PREVIEW (static Gantt) ===== */}
                <h3 className="font-semibold text-sm">Plan preview</h3>
                {summary && plan ? (
                    <div className="mt-2 overflow-x-auto">
                        <GanttChart
                            machines={plan.machines}
                            jobs={plan.jobs}
                            schedule={summary}
                            colors={colors}
                            mode="plan"
                        />
                    </div>
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
                        {/* Two buttons, always present so the footer never
                            shifts when a schedule's status changes. The first
                            is one toggle: "Archive" for a Draft or Confirmed
                            schedule, "Unarchive" for an Archived one — same
                            slot, same click, opposite action. Only the label
                            and the enabled state move with the lifecycle:
                            - Draft: both live.
                            - Confirmed: Archive needs a successor on the floor,
                              and the live plan can never be deleted.
                            - Archived: the toggle restores; Delete opens the
                              strong type-the-name confirmation. */}
                        <span
                            title={
                                schedule.status === "confirmed" && !canArchive
                                    ? "Another confirmed schedule is required before this one can be archived."
                                    : undefined
                            }
                        >
                            <Button
                                intent="outline"
                                size="sm"
                                isDisabled={schedule.status === "confirmed" && !canArchive}
                                isPending={archiving}
                                onPress={onToggleArchive}
                            >
                                {schedule.status === "archived" ? "Unarchive" : "Archive"}
                            </Button>
                        </span>
                        <span
                            title={
                                schedule.status === "confirmed"
                                    ? "The live confirmed schedule cannot be deleted."
                                    : undefined
                            }
                        >
                            <Button
                                intent="danger"
                                size="sm"
                                isDisabled={schedule.status === "confirmed"}
                                isPending={deleting}
                                onPress={onDelete}
                            >
                                Delete schedule
                            </Button>
                        </span>
                    </span>
                </div>
            </CardContent>
        </Card>
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
