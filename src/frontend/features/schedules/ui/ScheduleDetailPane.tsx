import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { Separator } from "@/components/ui/separator";
import {
    Table,
    TableBody,
    TableCell,
    TableColumn,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { buildJobColors } from "@/domains/scheduling/colors";
import { formatDuration, formatOffset } from "@/domains/scheduling/format";
import { JobDot } from "@/domains/scheduling/ui/JobDot";
import type { TimelinePlan } from "@/domains/scheduling/timeline";
import { formatCreatedAt, shortScheduleId, type ScheduleRow } from "../model/archive";
import { ScheduleStatusBadge } from "./ScheduleStatusBadge";

/**
 * Right column of the Schedules page: everything known about one past run,
 * read-only. The machine-load bars and job-placement table are drawn exactly
 * as the Planner page draws them, from the same `timelineToPlan` translation.
 */
export function ScheduleDetailPane({
    schedule,
    plan,
    archiving,
    onToggleArchive,
}: {
    schedule: ScheduleRow;
    plan: TimelinePlan | null;
    archiving: boolean;
    onToggleArchive: () => void;
}) {
    const summary = plan?.schedule ?? null;
    const machineName = (id: string) => plan?.machines.find((machine) => machine.id === id)?.name ?? id;
    const colors = buildJobColors(plan?.jobs ?? []);
    const machinesUsed = summary
        ? summary.machineLoad.filter((load) => load.busyMins > 0).length
        : 0;
    const archived = schedule.status === "archived";
    // A confirmed schedule is the record of what the floor was told to do, so it
    // cannot leave the list the way a draft can — the Archive control is dead
    // for it, and the reason is spelled out rather than implied.
    const confirmLock = schedule.status === "confirmed";

    return (
        <Card className="min-w-0">
            <CardHeader className="gap-1">
                <p className="text-muted-fg text-xs">
                    Schedules › {shortScheduleId(schedule.id)}
                </p>
                <div className="flex items-center gap-3">
                    <CardTitle className="text-2xl">{shortScheduleId(schedule.id)}</CardTitle>
                    <ScheduleStatusBadge status={schedule.status} />
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
                    <Metadata
                        label="Status"
                        value={<ScheduleStatusBadge status={schedule.status} />}
                    />
                    <Metadata
                        label="Makespan"
                        value={schedule.makespanMins === null ? "—" : formatDuration(schedule.makespanMins)}
                    />
                    <Metadata
                        label="Operations"
                        value={schedule.opsCount === null ? "—" : schedule.opsCount}
                    />
                    <Metadata label="Jobs" value={summary ? plan!.jobs.length : "—"} />
                    <Metadata label="Machines used" value={summary ? machinesUsed : "—"} />
                    <Metadata label="Generated at" value={formatCreatedAt(schedule.createdAt)} />
                    <Metadata
                        label="Confirmed at"
                        value={schedule.confirmedAt === null ? "—" : formatCreatedAt(schedule.confirmedAt)}
                    />
                </dl>

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

                {/* ===== JOB PLACEMENT ===== */}
                <h3 className="font-semibold text-sm">Job placement</h3>
                {summary && plan ? (
                    <>
                        <p className="mt-1 text-muted-fg text-xs">
                            When each job opens and closes, in the lane order the engine reports.
                        </p>
                        <Table aria-label="Job placement" className="mt-2">
                            <TableHeader>
                                <TableColumn className="w-0">#</TableColumn>
                                <TableColumn isRowHeader>Job</TableColumn>
                                <TableColumn>Starts</TableColumn>
                                <TableColumn>Finishes</TableColumn>
                            </TableHeader>
                            <TableBody items={summary.order.map((id, index) => ({ id, index }))}>
                                {({ id, index }) => (
                                    <TableRow id={id}>
                                        <TableCell className="tabular-nums">{index + 1}</TableCell>
                                        <TableCell>
                                            <span className="flex items-center gap-2">
                                                <JobDot colors={colors} jobId={id} />
                                                <span>
                                                    {plan.jobs.find((job) => job.id === id)?.name ?? id}
                                                </span>
                                            </span>
                                        </TableCell>
                                        <TableCell className="tabular-nums">
                                            {formatOffset(summary.jobStart[id] ?? 0)}
                                        </TableCell>
                                        <TableCell className="tabular-nums">
                                            {formatOffset(summary.jobFinish[id] ?? 0)}
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </>
                ) : (
                    <p className="mt-2 text-muted-fg text-sm">No job placement available.</p>
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
                    <span title={confirmLock ? "Confirmed schedules are the record of what the floor ran, so they cannot be archived." : undefined}>
                        <Button
                            intent="outline"
                            size="sm"
                            isDisabled={confirmLock}
                            isPending={archiving}
                            onPress={onToggleArchive}
                        >
                            {archived ? "Unarchive" : "Archive"}
                        </Button>
                    </span>
                        {summary && (
                            <Link
                                href={`/manager/simulation?schedule=${encodeURIComponent(schedule.id)}`}
                                className={buttonStyles({ intent: "success", size: "sm" })}
                            >
                                Open in simulation →
                            </Link>
                        )}
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
