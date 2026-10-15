import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GridList, GridListItem } from "@/components/ui/grid-list";
import { HeaderCount } from "@/components/ui/header-count";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { PanelControls } from "@/core/panels/PanelChrome";
import type { JobColor } from "@/domains/scheduling/colors";
import { formatOffset } from "@/domains/scheduling/format";
import { JobDot } from "@/domains/scheduling/ui/JobDot";
import type { FloorTotals, JobNow, JobState, MachineActivity, MachineNow } from "../model/simulation";

/**
 * The read-outs under the Simulation page's chart: headline totals, what each
 * machine is doing, and how far each job has got. All presentational, drawn
 * from the `model/simulation` view of the plan at the current minute.
 */

export function FloorTotalsStrip({ totals, started }: { totals: FloorTotals; started: boolean }) {
    const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));
    return (
        <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Tile
                label="Operations done"
                value={`${totals.opsDone} / ${totals.opsTotal}`}
                hint={started ? `${pct(totals.opsDone, totals.opsTotal)}%` : "not started"}
            />
            <Tile label="Running now" value={totals.opsRunning} hint={totals.opsRunning === 1 ? "operation" : "operations"} />
            <Tile
                label="Jobs complete"
                value={`${totals.jobsDone} / ${totals.jobsTotal}`}
                hint={started ? `${pct(totals.jobsDone, totals.jobsTotal)}%` : "not started"}
            />
            <Tile
                label="Machines busy"
                value={`${totals.machinesBusy} / ${totals.machinesTotal}`}
                hint={started ? `${pct(totals.machinesBusy, totals.machinesTotal)}% in use` : "not started"}
            />
        </dl>
    );
}

function Tile({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
    return (
        <div className="flex flex-col-reverse rounded-lg border bg-muted px-3 py-2">
            <dt className="text-muted-fg text-xs">{label}</dt>
            <dd className="flex items-baseline gap-1.5">
                <span className="font-semibold text-base tabular-nums">{value}</span>
                <span className="truncate text-muted-fg text-xs">{hint}</span>
            </dd>
        </div>
    );
}

const ACTIVITY_BADGE: Record<MachineActivity["kind"], { intent: "info" | "warning" | "success" | "secondary"; label: string }> = {
    running: { intent: "info", label: "Running" },
    idle: { intent: "warning", label: "Idle" },
    finished: { intent: "success", label: "Done" },
    waiting: { intent: "secondary", label: "Waiting" },
};

export function MachinesNowPanel({
    machines,
    colors,
    jobName,
    highlightedMachineId,
    onHighlightMachine,
}: {
    machines: MachineNow[];
    colors: Map<string, JobColor>;
    jobName: (jobId: string) => string;
    highlightedMachineId: string | null;
    onHighlightMachine: (machineId: string | null) => void;
}) {
    return (
        <Card className="min-w-0">
            <CardHeader>
                <CardTitle>
                    Machines now
                    <HeaderCount label={`${machines.length} machines in this plan`}>{machines.length}</HeaderCount>
                </CardTitle>
                <CardDescription>Hover a machine to find its lane in the chart.</CardDescription>
                <CardAction>
                    <PanelControls />
                </CardAction>
            </CardHeader>
            <CardContent>
                <ul className="grid gap-2.5 sm:grid-cols-2">
                    {machines.map(({ machine, activity, doneCount, totalCount }) => {
                        const badge = ACTIVITY_BADGE[activity.kind];
                        const highlighted = highlightedMachineId === machine.id;
                        return (
                            <li
                                key={machine.id}
                                className={`min-w-0 rounded-lg border p-3 transition-colors ${highlighted ? "border-primary/40 bg-primary/10" : "bg-muted"}`}
                                onPointerEnter={() => onHighlightMachine(machine.id)}
                                onPointerLeave={() => onHighlightMachine(null)}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="truncate font-semibold text-sm" title={machine.name}>{machine.name}</span>
                                    <Badge intent={badge.intent} className="shrink-0">{badge.label}</Badge>
                                </div>
                                <ActivityDetail activity={activity} colors={colors} jobName={jobName} machineName={machine.name} />
                                <div className="mt-1.5 text-muted-fg text-xs tabular-nums">
                                    {doneCount} of {totalCount} operations done
                                </div>
                            </li>
                        );
                    })}
                </ul>
            </CardContent>
        </Card>
    );
}

function ActivityDetail({
    activity,
    colors,
    jobName,
    machineName,
}: {
    activity: MachineActivity;
    colors: Map<string, JobColor>;
    jobName: (jobId: string) => string;
    machineName: string;
}) {
    switch (activity.kind) {
        case "running":
            return (
                <>
                    <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs">
                        <JobDot colors={colors} jobId={activity.jobId} size="sm" />
                        <strong className="truncate">{jobName(activity.jobId)}</strong>
                        <span className="truncate text-muted-fg">
                            · Op {activity.opIndex}/{activity.opTotal} {activity.opName}
                        </span>
                    </div>
                    <ProgressBar aria-label={`${machineName} current operation progress`} value={activity.progressPct} className="mt-2">
                        <ProgressBarTrack className="min-w-0" />
                    </ProgressBar>
                    <div className="mt-1.5 text-muted-fg text-xs tabular-nums">finishes {formatOffset(activity.endMins)}</div>
                </>
            );
        case "idle":
            return <div className="mt-2 text-muted-fg text-xs tabular-nums">Next operation at {formatOffset(activity.nextStartMins)}</div>;
        case "waiting":
            return <div className="mt-2 text-muted-fg text-xs tabular-nums">First operation at {formatOffset(activity.firstStartMins)}</div>;
        case "finished":
            return <div className="mt-2 text-muted-fg text-xs">All work on this machine is complete.</div>;
    }
}

const JOB_BADGE: Record<JobState, { intent: "info" | "success" | "secondary"; label: string }> = {
    waiting: { intent: "secondary", label: "Waiting" },
    running: { intent: "info", label: "Running" },
    done: { intent: "success", label: "Done" },
};

export function JobProgressPanel({
    jobs,
    colors,
    selectedJobId,
    onSelectJob,
}: {
    jobs: JobNow[];
    colors: Map<string, JobColor>;
    selectedJobId: string | null;
    onSelectJob: (jobId: string | null) => void;
}) {
    return (
        <Card className="min-w-0">
            <CardHeader>
                <CardTitle>
                    Job progress
                    <HeaderCount label={`${jobs.length} jobs in this plan`}>{jobs.length}</HeaderCount>
                </CardTitle>
                <CardDescription>Select a job to pick it out in the chart.</CardDescription>
                <CardAction>
                    <PanelControls />
                </CardAction>
            </CardHeader>
            <CardContent className="scroll-rail max-h-[32rem] overflow-y-auto">
                <GridList
                    aria-label="Job progress"
                    selectionMode="single"
                    selectionBehavior="toggle"
                    items={jobs.map((job) => ({ ...job, id: job.jobId }))}
                    selectedKeys={selectedJobId ? new Set([selectedJobId]) : new Set()}
                    onSelectionChange={(keys) => {
                        if (keys === "all") return;
                        const [first] = Array.from(keys);
                        onSelectJob(typeof first === "string" ? first : null);
                    }}
                >
                    {(job) => {
                        const badge = JOB_BADGE[job.state];
                        const pct = job.totalCount === 0 ? 0 : (job.doneCount / job.totalCount) * 100;
                        return (
                            <GridListItem id={job.jobId} textValue={`${job.name}, ${badge.label}, ${job.doneCount} of ${job.totalCount} operations`}>
                                <span className="flex w-full min-w-0 flex-col gap-1.5">
                                    <span className="flex min-w-0 items-center gap-2">
                                        <JobDot colors={colors} jobId={job.jobId} size="sm" />
                                        <span className="truncate font-semibold text-sm">{job.name}</span>
                                        <Badge intent={badge.intent} className="ms-auto shrink-0">{badge.label}</Badge>
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <ProgressBar aria-label={`${job.name} operations complete`} value={pct} className="flex-1">
                                            <ProgressBarTrack className="min-w-0 [--progress-content-bg:var(--color-success)]" />
                                        </ProgressBar>
                                        <span className="w-12 shrink-0 text-right text-muted-fg text-xs tabular-nums">
                                            {job.doneCount}/{job.totalCount}
                                        </span>
                                    </span>
                                    <span className="text-muted-fg text-xs tabular-nums">
                                        {formatOffset(job.startMins)} → {formatOffset(job.finishMins)}
                                    </span>
                                </span>
                            </GridListItem>
                        );
                    }}
                </GridList>
            </CardContent>
        </Card>
    );
}
