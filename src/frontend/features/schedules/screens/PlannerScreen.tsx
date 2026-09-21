"use client";

import { Badge } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, CheckboxField, CheckboxGroup } from "@/components/ui/checkbox";
import { Link } from "@/components/ui/link";
import { Note } from "@/components/ui/note";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAuth } from "@/core/auth/AuthProvider";
import { reportBackendFailure, reportMutationError } from "@/core/feedback/reportMutationError";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { buildJobColors } from "@/domains/scheduling/colors";
import { formatDuration, formatOffset } from "@/domains/scheduling/format";
import { timelineToPlan } from "@/domains/scheduling/timeline";
import { GanttChart } from "@/domains/scheduling/ui/GanttChart";
import { JobDot } from "@/domains/scheduling/ui/JobDot";
import { TimelineNavigator, useTimelineZoom } from "@/domains/scheduling/ui/TimelineNavigator";
import { useJobSummaries } from "@/features/jobs/data/queries";
import { useMachines } from "@/features/machines/data/queries";
import {
    GenerationTimeout,
    useRequestSchedule,
    useScheduleGeneration,
    useScheduleSummaries,
    useScheduleTimeline,
    useScheduleValidation,
} from "@/features/schedules/data/queries";
import { ArrowPathIcon, ExclamationCircleIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
    type ScheduleStrategy,
    type ScheduleTimeline,
    type SchedulingIssue,
} from "../data/api";

/**
 * Planner (schedule builder).
 *
 * This page answers "what would the plan look like?" — the simulation answers
 * "what does the shop look like N minutes in?". It has no playback controls and
 * no wall-clock dates: the output is a plan measured from T+0.
 *
 * **Generation happens on the backend.** Pressing Generate posts to
 * `POST /api/v1/schedules`, which queues the run and answers 202 immediately.
 * The run itself happens on a worker, so the page then polls
 * `GET /api/v1/schedules/generations/{id}` until it reports an outcome, and on
 * success reads `GET /api/v1/schedules/{id}/timeline` for the schedule it made.
 *
 * Nothing here computes a time. `domains/scheduling/timeline.ts` translates the timeline into
 * the `GeneratedSchedule` the chart already draws — renaming and regrouping
 * only — so what is on screen is the engine's arithmetic rather than a second
 * opinion about it.
 */

/**
 * Where a generation run has got to.
 *
 * The transient states carry the generation id because it is the only handle on
 * a run in flight, and the one thing worth quoting when something stalls. The
 * terminal states are the six the API reports, split so each gets a screen that
 * says what actually happened rather than one shared "it didn't work".
 */
type Generation =
    | { status: "idle" }
    | { status: "queued"; generationId: string }
    | { status: "running"; generationId: string }
    | { status: "drawing"; scheduleId: string }
    /** `createdAt` is null for a plan generated in this session — it is "just now". */
    | { status: "ready"; scheduleId: string; timeline: ScheduleTimeline; createdAt: string | null }
    | { status: "rejected"; issues: SchedulingIssue[] }
    | { status: "unavailable"; message: string }
    | { status: "failed"; message: string }
    | { status: "timedOut"; generationId: string }
    | { status: "error"; message: string };

const IN_FLIGHT: ReadonlySet<Generation["status"]> = new Set([
    "queued",
    "running",
    "drawing",
] as const);

/** The engines a manager can choose between when queuing a run. */
const STRATEGIES: { value: ScheduleStrategy; label: string; hint: string }[] = [
    { value: "resched", label: "ReSched", hint: "Learned policy — fast, approximate" },
    { value: "exact", label: "Exact", hint: "Gurobi MILP — optimal, slower" },
];

/** `2026-09-07T04:11:22Z` → `7 Sep, 14:11`, in the reader's own timezone. */
function formatCreated(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    return at.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/**
 * The first segment of a UUID: enough to quote a run, short enough to read.
 *
 * Runs only. A *job* is never identified this way — a manager picks jobs by
 * name, while a generation id is an operational handle they may have to quote
 * to someone looking at the worker.
 */
function shortId(id: string): string {
    return id.split("-")[0] ?? id;
}

/** A full-page state for when the floor itself could not be read. */
function Placeholder({
    title,
    children,
    onRetry,
    danger = false,
}: {
    title: string;
    children: React.ReactNode;
    onRetry?: () => void;
    danger?: boolean;
}) {
    return (
        <ManagerPageState title={title} error={danger}>
            {children}
            {onRetry && <Button intent="outline" size="sm" className="mt-3" onPress={onRetry}><ArrowPathIcon />Try again</Button>}
        </ManagerPageState>
    );
}

/**
 * The centre column when there is no plan drawn.
 *
 * One branch per outcome. The distinctions matter: a rejected run is a problem
 * with the floor's data and lists what, a missing runtime is a deployment
 * problem, and a timeout means nothing ever picked the command up — three
 * different people fix those three things.
 */
function GenerationState({ generation }: { generation: Generation }) {
    switch (generation.status) {
        case "queued":
        case "running":
            return (
                <div className="rounded-lg border border-dashed p-8 text-center">
                    <h3 className="font-semibold text-lg">
                        {generation.status === "queued"
                            ? "Queued for the scheduling engine…"
                            : "Planning…"}
                    </h3>
                    <p className="mx-auto mt-2 max-w-prose text-muted-fg text-sm">
                        {generation.status === "queued"
                            ? "The command is on the queue, waiting for a worker to pick it up."
                            : "A worker is running the scheduling engine over the floor's operations."}{" "}
                        Run <code>{shortId(generation.generationId)}</code>.
                    </p>
                </div>
            );

        case "drawing":
            return (
                <div className="rounded-lg border border-dashed p-8 text-center">
                    <h3 className="font-semibold text-lg">Reading the schedule…</h3>
                    <p className="mx-auto mt-2 max-w-prose text-muted-fg text-sm">
                        The plan was written. Resolving it onto the clock with{" "}
                        <code>GET /schedules/{shortId(generation.scheduleId)}/timeline</code>.
                    </p>
                </div>
            );

        case "rejected":
            return (
                <Note intent="danger" role="alert" indicator={false}>
                    <div className="flex items-center gap-2">
                        <ExclamationCircleIcon className="size-5" />
                        <strong>The floor as it stands cannot be scheduled</strong>
                    </div>
                    <p className="mt-1">
                        The engine validated the operations, machines and dependencies in the
                        database and refused to plan them. Nothing was written.
                    </p>
                    {generation.issues.length > 0 ? (
                        <ul className="mt-2 list-disc space-y-1 ps-5">
                            {generation.issues.map((issue, index) => (
                                <li key={`${issue.code}-${index}`}>
                                    {issue.message} <code className="text-xs">{issue.code}</code>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="mt-2">The engine reported no specific reason.</p>
                    )}
                    {/* This issue names no operation, and a run covers the whole
                        database, so without this the manager is told the floor
                        failed with no way to find the job responsible. */}
                    {generation.issues.some((issue) => issue.code === "unsupported_dependency_shape") && (
                        <p className="mt-2">
                            This selection includes a job whose steps branch —
                            two steps waiting on the same earlier one, or one step waiting on
                            several — stops the whole floor being planned.{" "}
                            <Link href="/manager/jobs" className="underline">
                                Open the job backlog
                            </Link>{" "}
                            and look for a job whose graph splits or merges rather than running as
                            one line.
                        </p>
                    )}
                </Note>
            );

        case "unavailable":
            return (
                <Note intent="warning" role="alert" indicator={false}>
                    <strong>The scheduling engine is unavailable</strong>
                    <p className="mt-1">{generation.message}</p>
                </Note>
            );

        case "timedOut":
            return (
                <Note intent="warning" role="alert" indicator={false}>
                    <strong>Nothing picked up the run</strong>
                    <p className="mt-1">
                        Polling for run <code>{shortId(generation.generationId)}</code> stopped
                        before the API reported a terminal result. Refresh to check its current
                        status, or ask an administrator to inspect the worker.
                    </p>
                </Note>
            );

        case "failed":
        case "error":
            return (
                <Note intent="danger" role="alert" indicator={false}>
                    <div className="flex items-center gap-2">
                        <ExclamationCircleIcon className="size-5" />
                        <strong>The run did not finish</strong>
                    </div>
                    <p className="mt-1">{generation.message}</p>
                </Note>
            );

        default:
            return (
                <div className="rounded-lg border border-dashed p-8 text-center">
                    <h3 className="font-semibold text-lg">No plan yet</h3>
                    <p className="mx-auto mt-2 max-w-prose text-muted-fg text-sm">
                        Press <strong className="text-fg">Generate schedule</strong>. The scheduling
                        engine assigns the selected jobs&apos; operations to compatible machines and
                        places them on the earliest slots that respect their dependencies.
                        The run happens on a worker, so this page will wait for it.
                    </p>
                </div>
            );
    }
}

export default function PlannerPage() {
    const { user } = useAuth();
    const jobsQuery = useJobSummaries();
    const machinesQuery = useMachines();
    const schedulesQuery = useScheduleSummaries();
    const requestSchedule = useRequestSchedule();
    const [generationRequest, setGenerationRequest] = useState<{ id: string; deadline: number } | null>(null);
    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);
    const [strategy, setStrategy] = useState<ScheduleStrategy>("resched");
    const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
    const openJobs = useMemo(
        () => (jobsQuery.data ?? []).filter((job) => (job.backlog_status ?? "open") === "open"),
        [jobsQuery.data],
    );
    const openJobIds = useMemo(() => new Set(openJobs.map((job) => job.id)), [openJobs]);
    const validationQuery = useScheduleValidation(selectedJobIds);
    const validationIssuesByJobId = useMemo(() => {
        const issues = new Map<string, SchedulingIssue>();
        for (const issue of validationQuery.data?.issues ?? []) {
            if (issue.job_id) issues.set(issue.job_id, issue);
        }
        return issues;
    }, [validationQuery.data]);
    const generationQuery = useScheduleGeneration(generationRequest);
    const reportedGenerationFailure = useRef<string | null>(null);
    const latestSchedule = schedulesQuery.data?.[0] ?? null;
    const completedScheduleId =
        generationQuery.data?.status === "completed" ? generationQuery.data.schedule_id ?? null : null;
    const selectedScheduleId = generationRequest === null ? latestSchedule?.id ?? null : completedScheduleId;
    const timelineQuery = useScheduleTimeline(selectedScheduleId);

    const generation: Generation = useMemo(() => {
        if (generationRequest === null) {
            if (latestSchedule && timelineQuery.data) {
                return {
                    status: "ready",
                    scheduleId: latestSchedule.id,
                    timeline: timelineQuery.data,
                    createdAt: latestSchedule.created_at,
                };
            }
            return requestSchedule.isError
                ? { status: "error", message: errorMessage(requestSchedule.error) }
                : { status: "idle" };
        }
        if (generationQuery.error) {
            return generationQuery.error instanceof GenerationTimeout
                ? { status: "timedOut", generationId: generationQuery.error.generationId }
                : { status: "error", message: errorMessage(generationQuery.error) };
        }
        if (!generationQuery.data || generationQuery.data.status === "pending") {
            return { status: "queued", generationId: generationRequest.id };
        }
        if (generationQuery.data.status === "running") {
            return { status: "running", generationId: generationRequest.id };
        }
        if (generationQuery.data.status === "rejected") {
            return { status: "rejected", issues: generationQuery.data.issues };
        }
        if (generationQuery.data.status === "unavailable") {
            return { status: "unavailable", message: generationQuery.data.detail };
        }
        if (generationQuery.data.status === "failed") {
            return {
                status: "failed",
                message: generationQuery.data.detail,
            };
        }
        if (timelineQuery.error) return { status: "error", message: errorMessage(timelineQuery.error) };
        if (!timelineQuery.data) return { status: "drawing", scheduleId: completedScheduleId! };
        return { status: "ready", scheduleId: completedScheduleId!, timeline: timelineQuery.data, createdAt: null };
    }, [
        completedScheduleId,
        generationQuery.data,
        generationQuery.error,
        generationRequest,
        latestSchedule,
        requestSchedule.error,
        requestSchedule.isError,
        timelineQuery.data,
        timelineQuery.error,
    ]);

    const generate = () => {
        if (selectedJobIds.length === 0) return;
        setHighlightedJobId(null);
        requestSchedule.mutate({ startsAt: new Date().toISOString(), jobIds: selectedJobIds, strategy }, {
            onSuccess: (accepted) => {
                setGenerationRequest({ id: accepted.id, deadline: Date.now() + 180_000 });
            },
            onError: reportMutationError,
        });
    };

    const plan = useMemo(
        () => (generation.status === "ready" ? timelineToPlan(generation.timeline) : null),
        [generation],
    );
    // Zoom state for the plan chart: one number (pixels of track per hour) plus
    // the visible window, shared between the navigator bar in the header and
    // the chart's scroll container below.
    const timelineZoom = useTimelineZoom(plan?.schedule?.makespanMins ?? 0);

    // Colour is keyed to a job's position in the backlog rather than to its
    // position in a plan, so the swatch beside a job on the left is the colour
    // it wears on the chart, and a plan containing fewer jobs never repaints the
    // ones that remain. The plan's own jobs are the fallback for when the
    // backlog could not be read.
    const backlog = jobsQuery.data ?? null;
    const colors = useMemo(
        () => buildJobColors(backlog ?? plan?.jobs ?? []),
        [backlog, plan],
    );

    const busy = requestSchedule.isPending || IN_FLIGHT.has(generation.status);

    // A job can leave the backlog while this page is open. Settle the selection
    // during render so the next Generate press cannot send an id the page can
    // already see is no longer open.
    const currentSelection = selectedJobIds.filter((id) => openJobIds.has(id));
    if (currentSelection.length !== selectedJobIds.length) {
        setSelectedJobIds(currentSelection);
    }

    // The poll endpoint is a successful HTTP read even when the queued command
    // failed. Surface its API-authored failure once as feedback, while the
    // persistent state below keeps the full issue list available for review.
    useEffect(() => {
        const outcome = generationQuery.data;
        if (!outcome) return;

        if (outcome.status === "rejected") {
            const reportKey = `${outcome.id}:${outcome.status}`;
            if (reportedGenerationFailure.current === reportKey) return;
            reportedGenerationFailure.current = reportKey;
            const [firstIssue, ...remainingIssues] = outcome.issues.map((issue) => issue.message);
            if (firstIssue) reportBackendFailure(firstIssue, remainingIssues);
            return;
        }
        if (outcome.status !== "unavailable" && outcome.status !== "failed") return;
        const reportKey = `${outcome.id}:${outcome.status}`;
        if (reportedGenerationFailure.current === reportKey) return;
        reportedGenerationFailure.current = reportKey;
        reportBackendFailure(outcome.detail);
    }, [generationQuery.data]);

    // Every completed run is persisted by the backend before it reports success,
    // so once a plan drawn in this session resolves, tell the manager where to
    // find it again. Keyed to the schedule id so a re-render never repeats it.
    const savedToastFor = useRef<string | null>(null);
    useEffect(() => {
        if (generation.status !== "ready" || generation.createdAt !== null) return;
        if (savedToastFor.current === generation.scheduleId) return;
        savedToastFor.current = generation.scheduleId;
        toast.success(
            `Schedule ${shortId(generation.scheduleId)} was generated and automatically saved to Schedules.`,
            {
                description:
                    "Open the Schedules page to view its details or run it in the simulation.",
            },
        );
    }, [generation]);

    function toggleHighlight(jobId: string) {
        setHighlightedJobId((previous) => (previous === jobId ? null : jobId));
    }

    if (jobsQuery.isPending || machinesQuery.isPending) {
        return (
            <Placeholder title="Loading the floor…">
                Reading <code>GET /api/v1/jobs</code> and <code>GET /api/v1/machines</code>.
            </Placeholder>
        );
    }

    const floorError = jobsQuery.error ?? machinesQuery.error;

    if (floorError instanceof ApiError && floorError.isForbidden) {
        return (
            <Placeholder title="This needs a manager account">
                <p>
                    You are signed in as <strong>{user?.name}</strong> ({user?.role}). Generating
                    schedules is restricted to managers.
                </p>
                <p className="mt-2">Sign out and sign in with a manager account to continue.</p>
            </Placeholder>
        );
    }

    if (floorError) {
        return (
            <Placeholder
                title="Could not read the floor."
                danger
                onRetry={() => {
                    void jobsQuery.refetch();
                    void machinesQuery.refetch();
                }}
            >
                <p>{errorMessage(floorError)}</p>
                <p className="mt-1 text-muted-fg">
                    Check the API is running and that the database has been migrated.
                </p>
            </Placeholder>
        );
    }

    const jobs = jobsQuery.data ?? [];
    const machines = machinesQuery.data ?? [];
    const activeMachines = machines.filter((machine) => machine.active);
    const schedule = plan?.schedule ?? null;
    const machineName = (id: string) =>
        plan?.machines.find((machine) => machine.id === id)?.name ?? id;

    return (
        <ManagerShell actions={<>
                <ToggleGroup
                    aria-label="Scheduling engine"
                    selectionMode="single"
                    disallowEmptySelection
                    isDisabled={busy}
                    selectedKeys={new Set([strategy])}
                    onSelectionChange={(keys) => {
                        const [first] = Array.from(keys);
                        if (first === "resched" || first === "exact") setStrategy(first);
                    }}
                >
                    {STRATEGIES.map((option) => (
                        <ToggleGroupItem
                            key={option.value}
                            id={option.value}
                            aria-label={`${option.label} — ${option.hint}`}
                        >
                            {option.label}
                        </ToggleGroupItem>
                    ))}
                </ToggleGroup>

                {/* `isPending` rather than `isDisabled`: React Aria already stops
            {/* `isPending` rather than `isDisabled`: React Aria already stops
                    onPress firing while pending, and keeps the control focusable
                    and announced as busy instead of silently going dead. */}
            <Button onPress={generate} isPending={busy} isDisabled={selectedJobIds.length === 0}>
                {busy ? "Generating…" : schedule ? "Regenerate schedule" : "Generate schedule"}
            </Button>
        </>}>

            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,2.2fr)_minmax(260px,0.9fr)]">
                {/* ===== WHAT WILL BE SCHEDULED ===== */}
                <Card>
                    <CardHeader className="flex-row items-center gap-2.5">
                        <CardTitle>Released to schedule</CardTitle>
                        <Badge intent="secondary">
                            {selectedJobIds.length} / {openJobs.length}
                        </Badge>
                    </CardHeader>
                    <CardContent>
                        <Note intent="info">
                            Select the open jobs to include in this run. Jobs already planned,
                            completed or archived cannot be selected again.
                        </Note>

                        <CheckboxGroup
                            aria-label="Jobs to schedule"
                            value={selectedJobIds}
                            isDisabled={busy}
                            onChange={(values) => setSelectedJobIds([...values])}
                            className="mt-3"
                        >
                            {openJobs.map((job) => {
                                const issue = validationIssuesByJobId.get(job.id);
                                return (
                                    <CheckboxField
                                        key={job.id}
                                        value={job.id}
                                        className="rounded-lg p-2 transition-colors hover:bg-secondary"
                                    >
                                        <Checkbox>
                                            <span className="flex min-w-0 flex-col gap-0.5">
                                                <span className="flex items-center gap-2">
                                                    <JobDot colors={colors} jobId={job.id} />
                                                    <span className="font-semibold text-sm">{job.name}</span>
                                                </span>
                                                {issue && (
                                                    <span className="text-danger text-xs">
                                                        {issue.message}
                                                    </span>
                                                )}
                                            </span>
                                        </Checkbox>
                                    </CheckboxField>
                                );
                            })}
                        </CheckboxGroup>

                        {validationQuery.data && validationQuery.data.issues.length > 0 && (
                            <Note intent="warning" className="mt-3">
                                <strong>This selection needs attention before it can be scheduled.</strong>
                                <ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
                                    {validationQuery.data.issues.map((issue, index) => (
                                        <li key={`${issue.code}-${issue.job_id ?? index}`}>
                                            {issue.message}
                                        </li>
                                    ))}
                                </ul>
                            </Note>
                        )}

                        {openJobs.length === 0 && (
                            <p className="mt-3 text-muted-fg text-sm">
                                No open jobs are available to schedule. {jobs.length === 0 && "Add a job first. "}
                                <Link href="/manager/jobs" className="text-primary">
                                    Open the backlog →
                                </Link>
                            </p>
                        )}

                        <Separator className="my-3" />
                        <div className="text-muted-fg text-sm">
                            {openJobs.length} open {openJobs.length === 1 ? "job" : "jobs"} ·{" "}
                            {activeMachines.length} of {machines.length} machines active
                        </div>
                        {activeMachines.length === 0 && machines.length > 0 && (
                            <p className="mt-1 text-danger text-xs">
                                Every machine is inactive, so no operation can be routed. A run will
                                be refused.
                            </p>
                        )}
                    </CardContent>
                </Card>

                {/* ===== PLAN ===== */}
                <Card className="min-w-0">
                    <CardHeader className="gap-3">
                        <CardTitle>Generated plan</CardTitle>
                        {generation.status === "ready" && schedule && (
                            <div className="flex items-center gap-4">
                                <span className="shrink-0 text-muted-fg text-xs">
                                    makespan {formatDuration(schedule.makespanMins)} · {schedule.ops.length} operations ·{" "}
                                    {generation.createdAt === null ? "generated just now" : formatCreated(generation.createdAt)}
                                </span>
                                <div className="ml-auto min-w-0 flex-1 max-w-md">
                                    <TimelineNavigator controls={timelineZoom} />
                                </div>
                            </div>
                        )}
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {plan && schedule ? (
                            <GanttChart
                                machines={plan.machines}
                                jobs={plan.jobs}
                                schedule={schedule}
                                colors={colors}
                                mode="plan"
                                selectedJobId={highlightedJobId}
                                onSelectJob={toggleHighlight}
                                zoom={timelineZoom}
                            />
                        ) : (
                            <GenerationState generation={generation} />
                        )}
                    </CardContent>
                </Card>

                {/* ===== SUMMARY ===== */}
                <Card>
                    <CardHeader>
                        <CardTitle>Plan summary</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {plan && schedule ? (
                            <>
                                <div className="grid grid-cols-2 gap-2.5">
                                    <div className="rounded-lg border bg-muted p-3">
                                        <div className="font-bold text-xl tabular-nums">
                                            {formatDuration(schedule.makespanMins)}
                                        </div>
                                        <div className="text-muted-fg text-xs">Makespan</div>
                                    </div>
                                    <div className="rounded-lg border bg-muted p-3">
                                        <div className="font-bold text-xl tabular-nums">
                                            {schedule.order.length}
                                        </div>
                                        <div className="text-muted-fg text-xs">Jobs</div>
                                    </div>
                                </div>

                                <h3 className="mt-5 font-semibold text-sm">Machine load</h3>
                                <ul className="mt-2 space-y-2">
                                    {schedule.machineLoad
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

                                {/* Every job's placement in text, so the plan is readable
                                    without relying on the colour channel. */}
                                <h3 className="mt-5 font-semibold text-sm">Job placement</h3>
                                <p className="mt-1 text-muted-fg text-xs">
                                    When each job opens and closes, in the lane order the engine
                                    itself reports. Click a row to trace it on the grid.
                                </p>
                                <Table
                                    aria-label="Job placement"
                                    selectionMode="single"
                                    selectionBehavior="replace"
                                    selectedKeys={highlightedJobId ? new Set([highlightedJobId]) : new Set()}
                                    onSelectionChange={(keys) => {
                                        if (keys === "all") return;
                                        const [first] = Array.from(keys);
                                        setHighlightedJobId(typeof first === "string" ? first : null);
                                    }}
                                    className="mt-2"
                                >
                                    <TableHeader>
                                        <TableColumn className="w-0">#</TableColumn>
                                        <TableColumn isRowHeader>Job</TableColumn>
                                        <TableColumn>Starts</TableColumn>
                                        <TableColumn>Finishes</TableColumn>
                                    </TableHeader>
                                    <TableBody items={schedule.order.map((id, index) => ({ id, index }))}>
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
                                                    {formatOffset(schedule.jobStart[id] ?? 0)}
                                                </TableCell>
                                                <TableCell className="tabular-nums">
                                                    {formatOffset(schedule.jobFinish[id] ?? 0)}
                                                </TableCell>
                                            </TableRow>
                                        )}
                                    </TableBody>
                                </Table>

                                <Separator className="my-3" />
                                <Link
                                    href="/manager/simulation"
                                    className={buttonStyles({ intent: "success", className: "w-full" })}
                                >
                                    Run this plan in the simulation →
                                </Link>
                            </>
                        ) : (
                            <p className="text-muted-fg text-sm">
                                Generate a schedule to see its makespan, machine load and job
                                placement.
                            </p>
                        )}
                    </CardContent>
                </Card>
            </main>
        </ManagerShell>
    );
}
