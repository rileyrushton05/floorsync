"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import {
    Table,
    TableBody,
    TableCell,
    TableColumn,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { errorMessage } from "@/core/http/errors";
import { statusIntent } from "@/core/presentation/badge-intent";
import { ExpandListButton } from "@/components/ui/list-pager";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { formatDuration, formatOffset } from "@/domains/scheduling/format";
import { useJobSummaries } from "@/features/jobs/data/queries";
import { useMachines } from "@/features/machines/data/queries";
import { FALLBACK_POLL_MS, useActiveSimulation } from "@/features/operator/data/queries";
import { simulatedMinutes } from "@/features/operator/model/operator-queue";
import { useScheduleSummaries, useScheduleTimeline } from "@/features/schedules/data/queries";
import { strategyColor, strategyLabel } from "@/features/schedules/model/archive";
import {
    BriefcaseIcon,
    ChevronRightIcon,
    ClipboardDocumentListIcon,
    ClockIcon,
    Cog6ToothIcon,
    CpuChipIcon,
    PlayCircleIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import {
    BACKLOG_ORDER,
    backlogCounts,
    jobProgress,
    machineLoad,
    overviewScheduleId,
    recentMakespans,
    type JobProgress,
} from "./model/overview";
import { BarChart, DonutChart } from "./ui/charts";

const BACKLOG_LABELS = { open: "Open", planned: "Planned", done: "Done", archived: "Archived" } as const;
const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
/**
 * The legend entries for the recent-schedules chart. The colours come from
 * `strategyColor` in the schedules model so the legend cannot drift from the
 * bars — both read the same mapping.
 */
const STRATEGY_LABELS: Record<string, string> = { resched: "ReSched", exact: "Exact" };
/** Rows of "Today's Jobs" shown before the tail folds behind "View all". */
const JOBS_SHOWN_LIMIT = 6;

export default function OverviewScreen() {
    // `paneScroll` locks the dashboard to the viewport from `xl` up: the
    // primary dashboard must always fit one page so its cards stay comparable,
    // and any overflow scrolls inside the body, not the document.
    return (
        <ManagerShell paneScroll>
            <OverviewBody />
        </ManagerShell>
    );
}

function OverviewBody() {
    const jobsQuery = useJobSummaries();
    const machinesQuery = useMachines();
    const schedulesQuery = useScheduleSummaries();
    const simulationQuery = useActiveSimulation(FALLBACK_POLL_MS);

    const simulation = simulationQuery.data ?? null;
    const schedules = useMemo(() => schedulesQuery.data ?? [], [schedulesQuery.data]);
    const scheduleId = overviewScheduleId(simulation?.schedule_id ?? null, schedules);
    const timelineQuery = useScheduleTimeline(scheduleId);
    const timeline = timelineQuery.data ?? null;

    // The API reports the clock as of `derived_at`; between polls it is
    // advanced locally so progress moves smoothly.
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        if (!simulation?.is_running) return;
        const timer = setInterval(() => setNowMs(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [simulation?.is_running]);

    const simulating = simulation !== null && simulation.schedule_id === scheduleId;
    const started = simulating && simulation.status !== "not_started";
    const nowMins = started ? simulatedMinutes(simulation, nowMs) : null;

    const jobs = useMemo(() => (timeline ? jobProgress(timeline, nowMins) : []), [timeline, nowMins]);
    const loads = useMemo(() => (timeline ? machineLoad(timeline, nowMins) : []), [timeline, nowMins]);
    const backlog = useMemo(
        () => backlogCounts((jobsQuery.data ?? []).map((job) => job.backlogStatus)),
        [jobsQuery.data],
    );
    const makespans = useMemo(() => recentMakespans(schedules), [schedules]);

    const error = jobsQuery.error ?? machinesQuery.error ?? schedulesQuery.error ?? simulationQuery.error ?? timelineQuery.error;
    const machines = machinesQuery.data ?? [];
    const activeMachines = machines.filter((machine) => machine.active).length;
    const busyNow = loads.filter((load) => load.busyNow).length;
    const progressPct = timeline && nowMins !== null && timeline.makespan > 0
        ? Math.round((nowMins / timeline.makespan) * 100)
        : 0;

    return (
        <main className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5 xl:scroll-rail">
            {error && (
                <div role="alert" className="rounded-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-danger-subtle-fg text-sm">
                    Some overview data could not be loaded: {errorMessage(error)}
                </div>
            )}

            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                    icon={ClipboardDocumentListIcon}
                    label="Open jobs"
                    value={backlog.open + backlog.planned}
                    caption={`${backlog.open} open · ${backlog.planned} planned`}
                />
                <StatCard
                    icon={CpuChipIcon}
                    label="Machines busy"
                    value={timeline ? busyNow : "–"}
                    suffix={timeline ? `/ ${loads.length}` : undefined}
                    caption={!timeline ? "No schedule running" : started ? "Working right now" : "Simulation not started"}
                />
                <StatCard
                    icon={PlayCircleIcon}
                    label="Schedule progress"
                    value={timeline ? `${progressPct}%` : "–"}
                    caption={
                        timeline
                            ? nowMins !== null
                                ? `${formatOffset(nowMins)} of ${formatDuration(timeline.makespan)}`
                                : `Makespan ${formatDuration(timeline.makespan)}`
                            : "Confirm a schedule to begin"
                    }
                >
                    {timeline && (
                        <ProgressBar aria-label="Schedule progress" value={progressPct} className="mt-3">
                            <ProgressBarTrack className="min-w-0" />
                        </ProgressBar>
                    )}
                </StatCard>
                <StatCard
                    icon={Cog6ToothIcon}
                    label="Active machines"
                    value={activeMachines}
                    suffix={`/ ${machines.length}`}
                    caption={`${machines.length - activeMachines} inactive`}
                />
            </div>

            <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
                <Card>
                    <CardHeader title="Job backlog" description="Every job by where it sits in the backlog" />
                    <CardContent>
                        <DonutChart
                            ariaLabel={`Job backlog: ${BACKLOG_ORDER.map((status) => `${backlog[status]} ${BACKLOG_LABELS[status].toLowerCase()}`).join(", ")}`}
                            totalLabel="jobs"
                            segments={BACKLOG_ORDER.map((status, i) => ({
                                key: status,
                                label: BACKLOG_LABELS[status],
                                value: backlog[status],
                                color: CHART_COLORS[i],
                            }))}
                        />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader title="Machine utilisation" description="Share of the schedule each machine spends working" />
                    <CardContent>
                        {timeline && loads.length > 0 ? (
                            <BarChart
                                ariaLabel={`Machine utilisation: ${loads.map((load) => `${load.label} ${load.utilizationPct}%`).join(", ")}`}
                                max={100}
                                format={(value) => `${value}%`}
                                data={loads.map((load) => ({
                                    key: load.key,
                                    label: load.label,
                                    value: load.utilizationPct,
                                    color: "var(--chart-1)",
                                    detail: `${load.label}: ${load.utilizationPct}%${load.busyNow ? " · busy now" : ""}`,
                                }))}
                            />
                        ) : (
                            <EmptyChart>No confirmed schedule to measure yet.</EmptyChart>
                        )}
                    </CardContent>
                </Card>

                <Card className="lg:col-span-2 2xl:col-span-1">
                    <CardHeader title="Recent schedules" description="Makespan of the latest generated schedules" />
                    <CardContent>
                        {makespans.length > 0 ? (
                            <>
                                <BarChart
                                    ariaLabel={`Makespan of recent schedules: ${makespans.map((item) => formatDuration(item.makespan)).join(", ")}`}
                                    format={(value) => formatDuration(value)}
                                    data={makespans.map((item, i) => ({
                                        key: item.id,
                                        label: `#${i + 1}`,
                                        value: item.makespan,
                                        // The strategy string is a versioned
                                        // identifier, so the colour goes through
                                        // the family mapping rather than a bare
                                        // key lookup (which fell through to the
                                        // fallback green for every bar).
                                        color: strategyColor(item.strategy),
                                        detail: `${strategyLabel(item.strategy)} · ${formatDuration(item.makespan)} · ${item.status}`,
                                        dotColor: strategyColor(item.strategy),
                                    }))}
                                />
                                <div className="mt-3 flex gap-4 text-muted-fg text-xs">
                                    {Object.entries(STRATEGY_LABELS).map(([strategy, label]) => (
                                        <span key={strategy} className="flex items-center gap-1.5">
                                            <span className="size-2.5 rounded-full" style={{ background: strategyColor(strategy) }} />
                                            {label}
                                        </span>
                                    ))}
                                </div>
                            </>
                        ) : (
                            <EmptyChart>No schedules generated yet.</EmptyChart>
                        )}
                    </CardContent>
                </Card>
            </div>

            {timeline ? (
                <ScheduleJobs jobs={jobs} />
            ) : (
                <Card>
                    <CardContent className="flex flex-col items-center gap-2 py-6 text-center">
                        <ClockIcon className="size-8 text-muted-fg" />
                        <p className="font-semibold">No schedule on the floor yet</p>
                        <p className="text-muted-fg text-sm">
                            Generate and confirm a schedule in the planner to see job progress here.
                        </p>
                        <Link href="/manager/planner" className="text-primary text-sm">Open the planner →</Link>
                    </CardContent>
                </Card>
            )}
        </main>
    );
}

function StatCard({
    icon: Icon,
    label,
    value,
    suffix,
    caption,
    children,
}: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: React.ReactNode;
    suffix?: string;
    caption: string;
    children?: React.ReactNode;
}) {
    return (
        <Card>
            <CardContent>
                <div className="flex items-center gap-2.5 font-medium text-muted-fg text-sm">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="size-4.5" />
                    </span>
                    {label}
                </div>
                <div className="mt-3 font-bold text-3xl tabular-nums">
                    {value}
                    {suffix && <span className="ms-1.5 font-normal text-base text-muted-fg">{suffix}</span>}
                </div>
                <div className="mt-1 text-muted-fg text-sm">{caption}</div>
                {children}
            </CardContent>
        </Card>
    );
}

function EmptyChart({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-52 items-center justify-center rounded-lg border border-dashed text-muted-fg text-sm">
            {children}
        </div>
    );
}

function ScheduleJobs({ jobs }: { jobs: JobProgress[] }) {
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [expandedFor, setExpandedFor] = useState<string | null>(null);
    // Expansion is keyed to the list contents: a schedule change replaces
    // `jobs`, so the remembered key no longer matches and the view resets
    // to collapsed.
    const isExpanded = jobs.length > 0 && expandedFor === jobs[0]?.key;
    const selected = jobs.find((job) => job.key === selectedKey)
        ?? jobs.find((job) => job.state === "In progress")
        ?? jobs[0]
        ?? null;
    // The tail folds behind a "View all" toggle: a long schedule would otherwise
    // push the detail card far below the fold. The current selection stays
    // visible in either state, and the expansion is forgotten when the schedule
    // (a change of `jobs`) replaces the list.
    const shown =
        selected === null || isExpanded || jobs.findIndex((job) => job.key === selected.key) < JOBS_SHOWN_LIMIT
            ? isExpanded ? jobs : jobs.slice(0, JOBS_SHOWN_LIMIT)
            : jobs.filter((job, index) => index < JOBS_SHOWN_LIMIT || job.key === selected.key);
    const hiddenCount = isExpanded ? 0 : jobs.length - shown.length;

    return (
        <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
            <Card>
                <CardHeader>
                    <CardTitle>Jobs in this schedule</CardTitle>
                    <CardDescription>Select a job to see where it is now</CardDescription>
                </CardHeader>
                <CardContent>
                    {/* Expanded, the whole list scrolls inside the card: the
                        dashboard itself must keep fitting one page. */}
                    <div className={isExpanded ? "max-h-96 overflow-y-auto scroll-rail" : undefined}>
                    <Table
                        aria-label="Jobs in this schedule"
                        selectionMode="single"
                        selectionBehavior="replace"
                        selectedKeys={selected ? new Set([selected.key]) : new Set()}
                        onSelectionChange={(keys) => {
                            if (keys === "all") return;
                            const [first] = Array.from(keys);
                            if (typeof first === "string") setSelectedKey(first);
                        }}
                    >
                        <TableHeader>
                            <TableColumn isRowHeader>Job</TableColumn>
                            <TableColumn>Progress</TableColumn>
                            <TableColumn>Status</TableColumn>
                            <TableColumn>Current machine</TableColumn>
                            <TableColumn />
                        </TableHeader>
                        <TableBody items={shown}>
                            {(job) => (
                                <TableRow id={job.key}>
                                    <TableCell className="font-semibold">{job.label}</TableCell>
                                    <TableCell>
                                        <div className="flex items-center gap-2">
                                            <ProgressBar aria-label={`${job.label} progress`} value={job.progressPct} className="w-24">
                                                <ProgressBarTrack className="min-w-0" />
                                            </ProgressBar>
                                            <span className="text-xs tabular-nums">{job.doneCount}/{job.totalCount}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Badge intent={statusIntent(job.state)}>{job.state}</Badge>
                                    </TableCell>
                                    <TableCell>{job.current?.machineLabel ?? "–"}</TableCell>
                                    <TableCell className="text-right">
                                        <Link
                                            href={`/manager/jobs?job=${encodeURIComponent(job.key)}`}
                                            aria-label={`Open ${job.label} in the job backlog`}
                                            className="inline-flex items-center text-muted-fg transition hover:text-primary"
                                        >
                                            <ChevronRightIcon className="size-4" />
                                        </Link>
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                    </div>

                    {(hiddenCount > 0 || isExpanded) && (
                        <div className="mt-3">
                            <ExpandListButton
                                hiddenCount={hiddenCount}
                                expanded={isExpanded}
                                onToggle={() => {
                                    if (isExpanded) setExpandedFor(null);
                                    else setExpandedFor(jobs[0]?.key ?? null);
                                }}
                                noun="jobs"
                            />
                        </div>
                    )}
                </CardContent>
            </Card>

            {selected && <JobDetail job={selected} />}
        </div>
    );
}

function JobDetail({ job }: { job: JobProgress }) {
    return (
        <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
                <CardTitle>{job.label}</CardTitle>
                <Badge intent={statusIntent(job.state)}>{job.state}</Badge>
            </CardHeader>
            <CardContent className="space-y-5">
                <ProgressBar aria-label="Job progress" value={job.progressPct}>
                    <div className="mb-2 flex items-center justify-between text-sm">
                        <span className="text-muted-fg">Operations complete</span>
                        <span className="font-semibold tabular-nums">{job.doneCount} of {job.totalCount}</span>
                    </div>
                    <ProgressBarTrack className="h-2.5 min-w-0" />
                </ProgressBar>

                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border bg-muted p-3">
                        <div className="flex items-center gap-2 font-medium text-primary text-xs">
                            <BriefcaseIcon className="size-4" />
                            Currently on
                        </div>
                        {job.current ? (
                            <>
                                <div className="mt-1.5 font-semibold text-sm">{job.current.machineLabel}</div>
                                <div className="text-muted-fg text-xs">
                                    Op {job.current.index} of {job.current.total} · {job.current.label}
                                </div>
                                <div className="mt-1 text-muted-fg text-xs">Started {formatOffset(job.current.start)}</div>
                            </>
                        ) : (
                            <div className="mt-1.5 text-muted-fg text-xs">
                                {job.state === "Completed" ? "Job complete." : "Between operations."}
                            </div>
                        )}
                    </div>

                    <div className="rounded-lg border bg-muted p-3">
                        <div className="flex items-center gap-2 font-medium text-warning-subtle-fg text-xs">
                            <ClockIcon className="size-4" />
                            Next step
                        </div>
                        {job.next ? (
                            <>
                                <div className="mt-1.5 font-semibold text-sm">
                                    Op {job.next.index} of {job.next.total} · {job.next.label}
                                </div>
                                <div className="text-muted-fg text-xs">Starts {formatOffset(job.next.start)}</div>
                                <div className="mt-1 text-muted-fg text-xs">{job.next.machineLabel}</div>
                            </>
                        ) : (
                            <div className="mt-1.5 text-muted-fg text-xs">No further steps.</div>
                        )}
                    </div>
                </div>

                <ol className="space-y-1.5">
                    {job.steps.map((step) => (
                        <li key={step.index} className="flex items-center gap-2.5 text-sm">
                            <span
                                className={`flex size-6 shrink-0 items-center justify-center rounded-full font-semibold text-xs ${step.state === "done"
                                    ? "bg-success text-success-fg"
                                    : step.state === "current"
                                        ? "bg-primary text-primary-fg"
                                        : "bg-secondary text-secondary-fg"
                                    }`}
                            >
                                {step.state === "done" ? "✓" : step.index}
                            </span>
                            <span className={`flex-1 ${step.state === "pending" ? "text-muted-fg" : ""}`}>{step.label}</span>
                            <span className="text-muted-fg text-xs">{step.machineLabel}</span>
                        </li>
                    ))}
                </ol>
            </CardContent>
        </Card>
    );
}
