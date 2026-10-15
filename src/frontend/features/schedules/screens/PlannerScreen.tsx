"use client";

import { Badge } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    GridList,
    GridListDescription,
    GridListEmptyState,
    GridListItem,
    GridListLabel,
} from "@/components/ui/grid-list";
import { HeaderCount } from "@/components/ui/header-count";
import { Input, InputGroup } from "@/components/ui/input";
import { Link } from "@/components/ui/link";
import { ListPager, useCollapsedRows } from "@/components/ui/list-pager";
import { Note } from "@/components/ui/note";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
    Table,
    TableBody,
    TableCell,
    TableColumn,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { TextField } from "@/components/ui/text-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { InfoTooltip } from "@/components/ui/tooltip";
import { useAuth } from "@/core/auth/AuthProvider";
import { ConfirmDialog } from "@/core/feedback/ConfirmDialog";
import { reportBackendFailure, reportMutationError } from "@/core/feedback/reportMutationError";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { useSaveShortcut } from "@/core/keyboard/useSaveShortcut";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { reportingDateStartsAt } from "@/core/shell/ReportingDate";
import { SidePane, SidePaneLayout, SidePaneMain } from "@/core/shell/SidePanes";
import { buildJobColors } from "@/domains/scheduling/colors";
import { formatDuration, formatOffset } from "@/domains/scheduling/format";
import { timelineToPlan } from "@/domains/scheduling/timeline";
import { GanttChart } from "@/domains/scheduling/ui/GanttChart";
import { JobDot } from "@/domains/scheduling/ui/JobDot";
import { useTimelineZoom } from "@/domains/scheduling/ui/useTimelineZoom";
import { useJobSummaries } from "@/features/jobs/data/queries";
import { useMachines } from "@/features/machines/data/queries";
import {
    GenerationTimeout,
    useDeleteSchedule,
    useRequestSchedule,
    useScheduleGeneration,
    useScheduleSummaries,
    useScheduleTimeline,
    useScheduleValidation,
    useUpdateSchedule,
} from "@/features/schedules/data/queries";
import { formatCreatedAt, shortScheduleId, strategyLabel } from "@/features/schedules/model/archive";
import { PlanStartDateDialog } from "@/features/schedules/ui/PlanStartDateDialog";
import { SavePlanPanel, type SavePanelState } from "@/features/schedules/ui/SavePlanPanel";
import { ArrowLeftIcon, ArrowPathIcon, ClockIcon, ExclamationCircleIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { getLocalTimeZone, today, type CalendarDate } from "@internationalized/date";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
    type ScheduleStrategy,
    type ScheduleTimeline,
    type SchedulingIssue,
} from "../data/api";

const JOB_SORTS = [
    { id: "newest", label: "Newest first" },
    { id: "oldest", label: "Oldest first" },
    { id: "name", label: "Name (A–Z)" },
] as const;

type JobSort = (typeof JOB_SORTS)[number]["id"];

const JOB_STATUS_FILTERS = [
    { id: "all", label: "All jobs" },
    { id: "open", label: "Unplanned jobs" },
    { id: "planned", label: "Planned jobs" },
] as const;

type JobStatusFilter = (typeof JOB_STATUS_FILTERS)[number]["id"];

/**
 * Planner: where a schedule is made.
 *
 * The flow is Schedules → "New Schedule" → here: pick the open jobs, choose an
 * engine, generate, then name the plan and save it. Saving confirms it (so it
 * can be run in the simulation) and returns to the Schedules page with it
 * selected. "Open in planner" on an unsaved draft lands here too, via
 * `?schedule=<id>`, to finish naming and saving it.
 *
 * **Generation happens on the backend.** Pressing Generate posts to
 * `POST /api/v1/schedules`, which queues the run and answers 202 immediately.
 * The run itself happens on a worker, so the page then polls
 * `GET /api/v1/schedules/generations/{id}` until it reports an outcome, and on
 * success reads `GET /api/v1/schedules/{id}/timeline` for the schedule it made.
 * The worker stores every completed run as an unnamed draft; saving is a
 * `PATCH` that names it and, unless kept as a draft, confirms it.
 *
 * Nothing here computes a time. `domains/scheduling/timeline.ts` translates the timeline into
 * the `GeneratedSchedule` the chart already draws (renaming and regrouping
 * only), so what is on screen is the engine's arithmetic rather than a second
 * opinion about it.
 */

/**
 * Where a generation run has got to.
 *
 * The transient states carry the generation id because it is the only handle on
 * a run in flight, and the one thing worth quoting when something stalls. The
 * terminal states are the ones the API reports, split so each gets a screen that
 * says what actually happened rather than one shared "it didn't work".
 */
type Generation =
    | { status: "idle" }
    | { status: "queued"; generationId: string }
    | { status: "running"; generationId: string }
    | { status: "drawing"; scheduleId: string }
    /** `createdAt` is null for a plan generated in this session; it is "just now". */
    | { status: "ready"; scheduleId: string; timeline: ScheduleTimeline; createdAt: string | null }
    | { status: "missing"; scheduleId: string }
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
    { value: "resched", label: "ReSched", hint: "Learned policy, fast, approximate" },
    { value: "exact", label: "Exact", hint: "Gurobi MILP, optimal, slower" },
];

/** How long to poll a generation before giving up on it, in ms. */
const GENERATION_DEADLINE_MS = 180_000;

/** Fallback estimate for a strategy with no history this session, in seconds. */
const DEFAULT_ESTIMATE_S: Record<ScheduleStrategy, number> = {
    resched: 15,
    exact: 60,
};

/** How many past durations to average into the estimate. */
const HISTORY_SIZE = 3;

/** Past durations per strategy, in seconds. In-memory: a session's worth of
    history is enough, and localStorage would go stale after engine updates. */
const durationHistory = new Map<ScheduleStrategy, number[]>();

/** The estimate a fresh run starts with: the mean of recent runs, or the
    strategy's default when this is the first run of the session. */
function estimateFor(strategy: ScheduleStrategy): number {
    const history = durationHistory.get(strategy);
    if (!history || history.length === 0) return DEFAULT_ESTIMATE_S[strategy];
    return history.reduce((sum, seconds) => sum + seconds, 0) / history.length;
}

/** Record a finished run's duration so the next estimate tracks reality. */
function recordDuration(strategy: ScheduleStrategy, seconds: number) {
    const history = durationHistory.get(strategy) ?? [];
    history.push(seconds);
    durationHistory.set(strategy, history.slice(-HISTORY_SIZE));
}

/**
 * Estimated seconds remaining and the bar percentage for the current run.
 *
 * The API exposes no progress field, so the percentage is a smooth curve that
 * advances quickly at first and slows down toward ~90% — a monotonic visual
 * cue that the run is ongoing, the way an npm-install bar behaves — and it
 * snaps to 100% only on success. The ETA is seeded from this session's past
 * runs for the strategy rather than a fixed maximum, so fast runs don't
 * promise three minutes. Updated at most once a second.
 */
function useGenerationProgress(
    generating: boolean,
    startedAt: number | null,
    strategy: ScheduleStrategy,
): { pct: number; remainingS: number | null; over: boolean } | null {
    const [progress, setProgress] = useState<{ pct: number; remainingS: number | null; over: boolean } | null>(null);

    useEffect(() => {
        if (!generating || startedAt === null) return;
        const estimateS = estimateFor(strategy);
        const tick = () => {
            const elapsedS = (Date.now() - startedAt) / 1000;
            // Ease-out curve: an asymptote at 90% keeps the bar moving early
            // and honest late — never a fabricated "almost done".
            const pct = Math.min(90, Math.round(90 * (1 - Math.exp(-elapsedS / estimateS))));
            if (elapsedS > estimateS * 2) {
                setProgress({ pct, remainingS: null, over: true });
            } else {
                setProgress({ pct, remainingS: Math.max(0, Math.ceil(estimateS - elapsedS)), over: false });
            }
        };
        tick();
        const timer = setInterval(tick, 1_000);
        return () => clearInterval(timer);
    }, [generating, startedAt, strategy]);

    return generating ? progress : null;
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
 * problem, and a timeout means nothing ever picked the command up. Three
 * different people fix those three things.
 */
function GenerationState({
    generation,
    progress,
    complete,
}: {
    generation: Generation;
    /** The live ETA/percentage estimate; null when not counting down. */
    progress: { pct: number; remainingS: number | null; over: boolean } | null;
    /** The run succeeded: fill the bar to 100% for a beat before the plan
        replaces this state, so the fill is seen to land. */
    complete: boolean;
}) {
    switch (generation.status) {
        case "queued":
        case "running":
            return (
                <div className="rounded-lg border border-dashed p-8 text-center" role="status">
                    <h3 className="font-semibold text-lg">
                        {generation.status === "queued"
                            ? "Queued for the scheduling engine…"
                            : "Planning…"}
                    </h3>
                    <p className="mx-auto mt-2 max-w-prose text-muted-fg text-sm">
                        {generation.status === "queued"
                            ? "The command is on the queue, waiting for a worker to pick it up."
                            : "A worker is running the scheduling engine over the selected jobs."}{" "}
                        Run <code>{shortScheduleId(generation.generationId)}</code>.
                    </p>
                    <div className="mx-auto mt-4 w-full max-w-sm">
                        {complete ? (
                            // The beat between the run succeeding and the plan
                            // drawing: the bar lands at 100% and stays there,
                            // so the fill is seen rather than cut.
                            <ProgressBar value={100} aria-label="Plan generation complete">
                                <ProgressBarTrack className="min-w-0" />
                            </ProgressBar>
                        ) : (
                            <>
                                <div className="flex items-center gap-1.5 text-muted-fg text-xs tabular-nums">
                                    <ClockIcon aria-hidden className="size-3.5" />
                                    <span>
                                        {progress === null
                                            ? "Estimating…"
                                            : progress.over
                                                ? "Taking longer than expected…"
                                                : `Estimated ${progress.remainingS}s remaining`}
                                    </span>
                                    {progress !== null && !progress.over && (
                                        <span className="ml-auto">~{progress.pct}%</span>
                                    )}
                                </div>
                                <ProgressBar
                                    value={progress?.pct ?? 0}
                                    className="mt-1.5"
                                    aria-label="Plan generation progress"
                                >
                                    <ProgressBarTrack className="min-w-0" />
                                </ProgressBar>
                            </>
                        )}
                    </div>
                </div>
            );

        case "drawing":
            return (
                <div className="rounded-lg border border-dashed p-8 text-center" role="status">
                    <h3 className="font-semibold text-lg">Reading the plan…</h3>
                    <p className="mx-auto mt-2 max-w-prose text-muted-fg text-sm">
                        Schedule <code>{shortScheduleId(generation.scheduleId)}</code> was written.
                        Loading its timeline to draw it.
                    </p>
                </div>
            );

        case "missing":
            return (
                <Note intent="warning" role="alert" indicator={false}>
                    <strong>That schedule no longer exists</strong>
                    <p className="mt-1">
                        Schedule <code>{shortScheduleId(generation.scheduleId)}</code> may have been
                        deleted. Generate a new plan, or{" "}
                        <Link href="/manager/schedules" className="underline">go back to Schedules</Link>.
                    </p>
                </Note>
            );

        case "rejected":
            return (
                <Note intent="danger" role="alert" indicator={false}>
                    <div className="flex items-center gap-2">
                        <ExclamationCircleIcon className="size-5" />
                        <strong>This selection cannot be scheduled</strong>
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
                    {/* This issue names no operation, so without this the
                        manager is told the run failed with no way to find the
                        job responsible. */}
                    {generation.issues.some((issue) => issue.code === "unsupported_dependency_shape") && (
                        <p className="mt-2">
                            This selection includes a job whose steps branch
                            (two steps waiting on the same earlier one, or one step waiting on
                            several). ReSched cannot plan that shape; try the Exact engine, or{" "}
                            <Link href="/manager/jobs" className="underline">
                                open the job backlog
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
                        Polling for run <code>{shortScheduleId(generation.generationId)}</code> stopped
                        before the API reported a result. If it finishes later it will appear on the
                        Schedules page as an untitled draft; otherwise ask an administrator to
                        inspect the worker.
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
                        Tick the jobs to include, choose an engine, then press{" "}
                        <strong className="text-fg">Generate plan</strong>. The scheduling engine
                        assigns the selected jobs&apos; operations to compatible machines and places
                        them on the earliest slots that respect their dependencies. When it looks
                        right, name it and save it.
                    </p>
                </div>
            );
    }
}

export default function PlannerPage() {
    return (
        <Suspense>
            <PlannerPageInner />
        </Suspense>
    );
}

function PlannerPageInner() {
    const { user } = useAuth();
    const router = useRouter();
    const jobsQuery = useJobSummaries();
    const machinesQuery = useMachines();
    const schedulesQuery = useScheduleSummaries();
    const requestSchedule = useRequestSchedule();
    const updateSchedule = useUpdateSchedule();
    const deleteSchedule = useDeleteSchedule();

    // An unsaved draft opened from the Schedules page ("Open in planner").
    // Without it the page starts a new schedule from scratch.
    const openedScheduleId = useSearchParams().get("schedule");

    const [generationRequest, setGenerationRequest] = useState<{ id: string; deadline: number } | null>(null);
    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);
    const [strategy, setStrategy] = useState<ScheduleStrategy>("resched");
    const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
    const [jobQuery, setJobQuery] = useState("");
    const [jobSort, setJobSort] = useState<JobSort>("newest");
    const [jobStatusFilter, setJobStatusFilter] = useState<JobStatusFilter>("all");
    const [name, setName] = useState("");
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    // The day the next plan starts on, asked for each time Generate is pressed.
    // Remembered so the dialog reopens on the day last used.
    const [startDate, setStartDate] = useState<CalendarDate>(() => today(getLocalTimeZone()));
    const [pickingStartDate, setPickingStartDate] = useState(false);

    // Open jobs and the ones a confirmed schedule already plans: a planned job
    // can still go into another draft, so the manager can compare an
    // alternative before discarding the confirmed plan. Archived and done jobs
    // are never offered.
    const plannableJobs = useMemo(
        () => (jobsQuery.data ?? []).filter((job) => job.backlogStatus === "open" || job.backlogStatus === "planned"),
        [jobsQuery.data],
    );
    const plannableJobIds = useMemo(() => new Set(plannableJobs.map((job) => job.id)), [plannableJobs]);
    const visibleJobs = useMemo(() => {
        const needle = jobQuery.trim().toLowerCase();
        const matching = plannableJobs.filter(
            (job) =>
                (jobStatusFilter === "all" || job.backlogStatus === jobStatusFilter) &&
                (needle === "" || job.name.toLowerCase().includes(needle)),
        );
        return [...matching].sort((left, right) => {
            if (jobSort === "name") return left.name.localeCompare(right.name);
            const byAge = Date.parse(left.createdAt) - Date.parse(right.createdAt);
            return jobSort === "oldest" ? byAge : -byAge;
        });
    }, [plannableJobs, jobQuery, jobSort, jobStatusFilter]);
    // Called before the page's early returns below — it is a hook, and the
    // early returns would make its call order conditional.
    const jobPager = useCollapsedRows(visibleJobs, null);
    const validationQuery = useScheduleValidation(selectedJobIds);
    const validationFeedback = useMemo(
        () => [
            ...(validationQuery.data?.issues ?? []),
            ...(validationQuery.data?.unsupported
                .filter((limit) => limit.strategy === strategy)
                .map((limit) => limit.issue) ?? []),
        ],
        [strategy, validationQuery.data],
    );
    const validationIssuesByJobId = useMemo(() => {
        const issues = new Map<string, SchedulingIssue>();
        for (const issue of validationFeedback) {
            if (issue.job_id) issues.set(issue.job_id, issue);
        }
        return issues;
    }, [validationFeedback]);

    const generationQuery = useScheduleGeneration(generationRequest);
    const reportedGenerationFailure = useRef<string | null>(null);
    const completedScheduleId =
        generationQuery.data?.status === "completed" ? generationQuery.data.schedule_id ?? null : null;
    // The schedule on screen: the one this session generated, or else the
    // draft that was opened by link.
    const currentScheduleId = generationRequest === null ? openedScheduleId : completedScheduleId;
    const currentSummary = schedulesQuery.data?.find((schedule) => schedule.id === currentScheduleId) ?? null;
    const timelineQuery = useScheduleTimeline(currentScheduleId);

    const generation: Generation = useMemo(() => {
        if (generationRequest === null) {
            if (requestSchedule.isError) return { status: "error", message: errorMessage(requestSchedule.error) };
            if (openedScheduleId === null) return { status: "idle" };
            if (schedulesQuery.isSuccess && currentSummary === null) {
                return { status: "missing", scheduleId: openedScheduleId };
            }
            if (timelineQuery.error) return { status: "error", message: errorMessage(timelineQuery.error) };
            if (!timelineQuery.data) return { status: "drawing", scheduleId: openedScheduleId };
            return {
                status: "ready",
                scheduleId: openedScheduleId,
                timeline: timelineQuery.data,
                createdAt: currentSummary?.created_at ?? null,
            };
        }
        if (generationQuery.error) {
            return generationQuery.error instanceof GenerationTimeout
                ? { status: "timedOut", generationId: generationQuery.error.generationId }
                : { status: "error", message: errorMessage(generationQuery.error) };
        }
        if (!generationQuery.data || generationQuery.data.status === "pending") {
            return { status: "queued", generationId: generationRequest.id };
        }
        switch (generationQuery.data.status) {
            case "running":
                return { status: "running", generationId: generationRequest.id };
            case "rejected":
                return { status: "rejected", issues: generationQuery.data.issues };
            case "unavailable":
                return { status: "unavailable", message: generationQuery.data.detail };
            case "failed":
                return { status: "failed", message: generationQuery.data.detail };
        }
        if (timelineQuery.error) return { status: "error", message: errorMessage(timelineQuery.error) };
        if (!timelineQuery.data) return { status: "drawing", scheduleId: completedScheduleId! };
        return { status: "ready", scheduleId: completedScheduleId!, timeline: timelineQuery.data, createdAt: null };
    }, [
        completedScheduleId,
        currentSummary,
        generationQuery.data,
        generationQuery.error,
        generationRequest,
        openedScheduleId,
        requestSchedule.error,
        requestSchedule.isError,
        schedulesQuery.isSuccess,
        timelineQuery.data,
        timelineQuery.error,
    ]);

    // Every run this session generates is a draft. An opened one is whatever
    // the list says; until the list arrives, nothing can be saved.
    const generatedThisSession = generationRequest !== null && completedScheduleId !== null;
    const currentIsDraft = generatedThisSession || currentSummary?.status === "draft";

    // An opened draft that was already named on the Schedules page brings its
    // name with it. Seeded once per schedule, during render rather than in an
    // effect, so the field never flashes empty first.
    const [nameSeededFor, setNameSeededFor] = useState<string | null>(null);
    if (currentSummary && nameSeededFor !== currentSummary.id) {
        setNameSeededFor(currentSummary.id);
        if (currentSummary.name && name.trim() === "") setName(currentSummary.name);
    }

    const plan = useMemo(
        () => (generation.status === "ready" ? timelineToPlan(generation.timeline) : null),
        [generation],
    );

    /** A beat where the bar sits filled at 100% before the plan replaces the
        loading state, so a successful run is seen to finish rather than cut.
        `beatFor` remembers which run has already had its fill — without it the
        trigger below would re-fire after the beat ended (runJustCompleted
        stays true while the plan is showing) and the bar would loop back to
        100% forever instead of giving way to the plan. */
    const [beatFor, setBeatFor] = useState<string | null>(null);
    const [beatActive, setBeatActive] = useState(false);
    const runJustCompleted =
        generationRequest !== null && completedScheduleId !== null && generation.status === "ready";
    if (runJustCompleted && beatFor !== completedScheduleId) {
        setBeatFor(completedScheduleId);
        setBeatActive(true);
    }
    const completing = beatActive && beatFor === completedScheduleId;
    // Hold the loading view (bar at 100%) for a short beat while completing.
    const showPlan = completing ? null : plan;
    useEffect(() => {
        if (!completing) return;
        const timer = setTimeout(() => setBeatActive(false), 400);
        return () => clearTimeout(timer);
    }, [completing]);
    // Zoom state for the plan chart: one number (pixels of track per hour),
    // driven by scrolling over the chart.
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

    const writing = updateSchedule.isPending || deleteSchedule.isPending;
    const generating = requestSchedule.isPending || IN_FLIGHT.has(generation.status);

    /** When the current (or most recent) run started, for the ETA estimate.
        Falls back to "now" when the timestamp is unknown so the estimate is
        still meaningful rather than null. */
    const generationStartedAt = useMemo(() => {
        if (!generating && generation.status !== "ready" && generation.status !== "drawing") return null;
        // The submitted-at timestamp is the run's true start; when it is
        // missing there is nothing to estimate against, so the hook simply
        // stays idle rather than fabricating a start time here.
        return generationRequest !== null ? requestSchedule.submittedAt : null;
    }, [generating, generation.status, generationRequest, requestSchedule.submittedAt]);
    const progress = useGenerationProgress(generating, generationStartedAt, strategy);

    // Every finished run feeds the next one's estimate, so the ETA tracks the
    // strategy's real cost instead of a fixed worst case.
    const recordedRunId = useRef<string | null>(null);
    useEffect(() => {
        if (
            generationRequest !== null &&
            generationStartedAt !== null &&
            generation.status === "ready" &&
            generationRequest.id !== recordedRunId.current
        ) {
            recordedRunId.current = generationRequest.id;
            recordDuration(strategy, (Date.now() - generationStartedAt) / 1000);
        }
    }, [generation.status, generationRequest, strategy, generationStartedAt]);
    const busy = generating || writing;
    const canGenerate =
        !busy && selectedJobIds.length > 0 && validationQuery.data?.schedulable[strategy] !== false;
    const canSave = generation.status === "ready" && currentIsDraft && name.trim() !== "" && !writing;

    // A job can be archived or finish running while this page is open. Settle
    // the selection during render so the next Generate press cannot send an id
    // the page can already see is no longer plannable.
    const currentSelection = selectedJobIds.filter((id) => plannableJobIds.has(id));
    if (currentSelection.length !== selectedJobIds.length) {
        setSelectedJobIds(currentSelection);
    }

    function generate(date: CalendarDate) {
        setPickingStartDate(false);
        setStartDate(date);
        if (!canGenerate) return;
        // A plan generated here and never saved is replaced, not kept: leaving
        // it behind would fill Schedules with untitled drafts nobody chose.
        const replacedDraftId = generatedThisSession && currentIsDraft ? completedScheduleId : null;
        setHighlightedJobId(null);
        requestSchedule.mutate({ startsAt: reportingDateStartsAt(date), jobIds: selectedJobIds, strategy }, {
            onSuccess: (accepted) => {
                setGenerationRequest({ id: accepted.id, deadline: Date.now() + GENERATION_DEADLINE_MS });
                if (replacedDraftId) deleteSchedule.mutate({ id: replacedDraftId }, { onError: reportMutationError });
            },
            onError: reportMutationError,
        });
    }

    async function save(confirm: boolean) {
        if (!canSave || currentScheduleId === null) return;
        const trimmed = name.trim();
        try {
            await updateSchedule.mutateAsync({
                id: currentScheduleId,
                name: trimmed,
                ...(confirm ? { status: "confirmed" as const } : {}),
            });
            toast.success(
                confirm ? `“${trimmed}” saved.` : `“${trimmed}” saved as a draft.`,
                {
                    description: confirm
                        ? "Run it from the Schedules or Simulation page whenever you are ready."
                        : "Confirm it from the Schedules page when you want to run it.",
                },
            );
            router.push(`/manager/schedules?schedule=${encodeURIComponent(currentScheduleId)}`);
        } catch (error) {
            reportMutationError(error);
        }
    }

    async function discard() {
        if (currentScheduleId === null || !currentIsDraft || writing) return;
        try {
            await deleteSchedule.mutateAsync({ id: currentScheduleId });
            setConfirmDiscard(false);
            setGenerationRequest(null);
            setHighlightedJobId(null);
            setName("");
            requestSchedule.reset();
            toast.success("Plan discarded.");
            if (openedScheduleId !== null) router.replace("/manager/planner");
        } catch (error) {
            setConfirmDiscard(false);
            reportMutationError(error);
        }
    }

    /** Ctrl+S / ⌘S saves and confirms, exactly as the Save button would. */
    useSaveShortcut(() => {
        if (confirmDiscard || writing) return;
        if (canSave) {
            void save(true);
            return;
        }
        if (generation.status === "ready" && currentIsDraft && name.trim() === "") {
            toast.warning("Name the schedule before saving it.");
        }
    });

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

    function toggleHighlight(jobId: string) {
        setHighlightedJobId((previous) => (previous === jobId ? null : jobId));
    }

    if (jobsQuery.isPending || machinesQuery.isPending) {
        return (
            <Placeholder title="Loading the floor…">
                Reading the job backlog and machines from the API.
            </Placeholder>
        );
    }

    const floorError = jobsQuery.error ?? machinesQuery.error;

    if (floorError instanceof ApiError && floorError.isForbidden) {
        return (
            <Placeholder title="This needs a manager account">
                <p>
                    You are signed in as <strong>{user?.name}</strong> ({user?.role}). Creating
                    schedules is restricted to managers.
                </p>
                <p className="mt-2">Sign out and sign in with a manager account to continue.</p>
            </Placeholder>
        );
    }

    if (floorError && (!jobsQuery.data || !machinesQuery.data)) {
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
    const schedule = showPlan?.schedule ?? null;
    const machineName = (id: string) =>
        showPlan?.machines.find((machine) => machine.id === id)?.name ?? id;
    const selectedIds = new Set(selectedJobIds);
    const allVisibleSelected = visibleJobs.length > 0 && visibleJobs.every((job) => selectedIds.has(job.id));
    const openJobCount = plannableJobs.filter((job) => job.backlogStatus === "open").length;
    const plannedJobCount = plannableJobs.length - openJobCount;
    const jobFiltersActive = jobQuery.trim() !== "" || jobStatusFilter !== "all";

    const saveState: SavePanelState =
        generation.status !== "ready" || currentScheduleId === null
            ? { kind: "empty" }
            : currentIsDraft
                ? { kind: "draft", scheduleId: currentScheduleId }
                : currentSummary && currentSummary.status !== "draft"
                    ? { kind: "saved", scheduleId: currentScheduleId, name: currentSummary.name, status: currentSummary.status }
                    : { kind: "empty" };

    return (
        <ManagerShell paneScroll actions={<>
            <Link href="/manager/schedules" className={buttonStyles({ intent: "plain", size: "sm" })}>
                <ArrowLeftIcon /> Schedules
            </Link>
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
                        aria-label={`${option.label}: ${option.hint}`}
                    >
                        {option.label}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>

            {/* `isPending` rather than `isDisabled` while running: React Aria
                already stops onPress firing while pending, and keeps the
                control focusable and announced as busy instead of silently
                going dead. */}
            <Button
                intent={schedule ? "outline" : "primary"}
                onPress={() => setPickingStartDate(true)}
                isPending={generating}
                isDisabled={!generating && !canGenerate}
            >
                {generating ? "Generating…" : schedule ? "Regenerate plan" : "Generate plan"}
            </Button>
        </>}>

            <SidePaneLayout paneScroll>
                {/* ===== WHAT WILL BE SCHEDULED ===== */}
                <SidePane id="planner.jobs" side="left" label="Jobs to plan" grow={0.8} minWidth={260} paneScroll>
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <span className="whitespace-nowrap">
                                    Jobs to plan
                                    <HeaderCount label={`${selectedJobIds.length} of ${plannableJobs.length} jobs selected`}>
                                        {selectedJobIds.length}/{plannableJobs.length}
                                    </HeaderCount>
                                </span>
                                <InfoTooltip label="About job selection">
                                    Select the jobs to include in this plan. Open jobs and jobs a confirmed
                                    schedule already plans can be selected; completed and archived jobs
                                    cannot.
                                </InfoTooltip>
                            </CardTitle>
                            {visibleJobs.length > 0 && (
                                <CardAction>
                                    <Button
                                        intent="plain"
                                        size="sm"
                                        isDisabled={busy}
                                        onPress={() => {
                                            const visibleIds = new Set(visibleJobs.map((job) => job.id));
                                            setSelectedJobIds(
                                                allVisibleSelected
                                                    ? selectedJobIds.filter((id) => !visibleIds.has(id))
                                                    : [...new Set([...selectedJobIds, ...visibleIds])],
                                            );
                                        }}
                                    >
                                        {allVisibleSelected ? "Clear" : "Select all"}
                                    </Button>
                                </CardAction>
                            )}
                        </CardHeader>
                        <CardContent>
                            {plannableJobs.length > 0 && (
                                <>
                                    <TextField
                                        aria-label="Search jobs to plan"
                                        value={jobQuery}
                                        onChange={setJobQuery}
                                    >
                                        <InputGroup>
                                            <MagnifyingGlassIcon data-slot="icon" />
                                            <Input placeholder="Search by job name…" autoComplete="off" />
                                        </InputGroup>
                                    </TextField>

                                    <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                                        <span className="font-semibold text-muted-fg text-xs uppercase tracking-[0.05em]">
                                            Filter
                                        </span>
                                        {jobFiltersActive && (
                                            <Button
                                                intent="plain"
                                                size="sm"
                                                onPress={() => {
                                                    setJobQuery("");
                                                    setJobStatusFilter("all");
                                                }}
                                            >
                                                <XMarkIcon /> Clear
                                            </Button>
                                        )}
                                    </div>

                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                        <Select
                                            aria-label="Filter by plan status"
                                            className="w-40"
                                            value={jobStatusFilter}
                                            onChange={(value) => setJobStatusFilter(value as JobStatusFilter)}
                                        >
                                            <SelectTrigger />
                                            <SelectContent>
                                                {JOB_STATUS_FILTERS.map((option) => (
                                                    <SelectItem key={option.id} id={option.id} textValue={option.label}>
                                                        {option.label}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <Separator className="my-5" />

                                    <div className="mb-3 flex flex-wrap items-center gap-2">
                                        <Select
                                            aria-label="Sort jobs to plan"
                                            className="w-44"
                                            value={jobSort}
                                            onChange={(value) => setJobSort(value as JobSort)}
                                        >
                                            <SelectTrigger />
                                            <SelectContent>
                                                {JOB_SORTS.map((option) => (
                                                    <SelectItem key={option.id} id={option.id} textValue={option.label}>
                                                        {option.label}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Badge intent="outline" className="ml-auto" role="status">
                                            Showing {jobPager.shown.length} of {visibleJobs.length}
                                        </Badge>
                                    </div>
                                </>
                            )}
                            {plannableJobs.length > 0 && (
                                <GridList
                                    aria-label="Jobs to schedule"
                                    selectionMode="multiple"
                                    selectionBehavior="toggle"
                                    items={jobPager.shown}
                                    disabledKeys={busy ? visibleJobs.map((job) => job.id) : []}
                                    // Jobs hidden by the search or filter stay selected:
                                    // narrowing the list is for finding jobs, not for
                                    // dropping ones already picked.
                                    selectedKeys={selectedIds}
                                    onSelectionChange={(keys) => {
                                        if (keys === "all") {
                                            setSelectedJobIds([...new Set([...selectedJobIds, ...visibleJobs.map((job) => job.id)])]);
                                            return;
                                        }
                                        setSelectedJobIds(Array.from(keys, String));
                                    }}
                                    renderEmptyState={() => (
                                        <GridListEmptyState className="text-center text-muted-fg text-sm">
                                            No jobs match your search or filters.
                                        </GridListEmptyState>
                                    )}
                                >
                                    {(job) => {
                                        const issue = validationIssuesByJobId.get(job.id);
                                        const planned = job.backlogStatus === "planned";
                                        const scheduleCount = job.plannedByScheduleIds.length;
                                        return (
                                            <GridListItem
                                                id={job.id}
                                                textValue={`${job.name}${planned ? " (planned)" : ""}`}
                                                // The grid list renders its selection box first;
                                                // `order-last` moves it to the trailing edge,
                                                // where the other lists keep their chevron, and
                                                // it centres on the row however tall it grows.
                                                className="*:data-[slot=control]:order-last *:data-[slot=control]:ms-auto"
                                            >
                                                {/* The dot stays with the name line rather than
                                                    centring, so it marks the job, not the row. */}
                                                <JobDot colors={colors} jobId={job.id} className="mt-1.5 self-start" />
                                                <span className="flex min-w-0 flex-col gap-0.5">
                                                    <span className="flex h-6 min-w-0 items-center gap-2">
                                                        <GridListLabel className="truncate text-sm">{job.name}</GridListLabel>
                                                        {planned && <Badge intent="secondary">Planned</Badge>}
                                                    </span>
                                                    {/* A blocking issue replaces the details: it is
                                                        the one thing about the row worth reading. */}
                                                    {issue ? (
                                                        <GridListDescription className="text-danger text-xs">
                                                            {issue.message}
                                                        </GridListDescription>
                                                    ) : (
                                                        <GridListDescription className="text-xs">
                                                            Added {formatCreatedAt(job.createdAt)}
                                                            {planned && scheduleCount > 0 &&
                                                                ` · in ${scheduleCount} ${scheduleCount === 1 ? "schedule" : "schedules"}`}
                                                        </GridListDescription>
                                                    )}
                                                </span>
                                            </GridListItem>
                                        );
                                    }}
                                </GridList>
                            )}

                            {/* Same collapse/expand footer as the Machines, Jobs
                                and Schedules lists: a long selection folds away
                                behind one toggle instead of running off screen. */}
                            {plannableJobs.length > 0 && (
                                <ListPager
                                    hiddenCount={jobPager.hiddenCount}
                                    expanded={jobPager.expanded}
                                    highlighted={jobPager.selectedIsHidden}
                                    onToggle={jobPager.toggle}
                                    noun="jobs"
                                />
                            )}

                            {validationFeedback.length > 0 && (
                                <Note intent="warning" className="mt-3">
                                    <strong>
                                        {validationQuery.data?.schedulable[strategy] === false
                                            ? `${strategy === "resched" ? "ReSched" : "Exact"} cannot schedule this selection.`
                                            : "This selection needs attention before it can be scheduled."}
                                    </strong>
                                    <ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
                                        {validationFeedback.map((issue, index) => (
                                            <li key={`${issue.code}-${issue.job_id ?? index}`}>
                                                {issue.message}
                                            </li>
                                        ))}
                                    </ul>
                                </Note>
                            )}

                            {plannableJobs.length === 0 && (
                                <p className="mt-3 text-muted-fg text-sm">
                                    No jobs are available to plan. {jobs.length === 0 && "Add a job first. "}
                                    <Link href="/manager/jobs" className="text-primary">
                                        Open the backlog →
                                    </Link>
                                </p>
                            )}

                            <Separator className="my-3" />
                            <div className="text-muted-fg text-sm">
                                {openJobCount} open · {plannedJobCount} planned ·{" "}
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
                </SidePane>

                {/* ===== PLAN ===== */}
                <SidePaneMain grow={2.2} paneScroll>
                    <Card className="min-w-0">
                        <CardHeader className="gap-1">
                            <CardTitle className="flex flex-wrap items-center gap-2.5">
                                {generation.status === "ready" && currentSummary?.name ? currentSummary.name : "Plan"}
                                {generation.status === "ready" && currentIsDraft && (
                                    <Badge intent="warning">Unsaved draft</Badge>
                                )}
                            </CardTitle>
                            {generation.status === "ready" && schedule && (
                                <span className="text-muted-fg text-xs">
                                    {currentSummary ? `${strategyLabel(currentSummary.strategy)} · ` : ""}
                                    makespan {formatDuration(schedule.makespanMins)} · {schedule.ops.length} operations ·{" "}
                                    {generation.createdAt === null ? "generated just now" : `generated ${formatCreatedAt(generation.createdAt)}`}
                                </span>
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
                                <GenerationState
                                    generation={generation}
                                    progress={progress}
                                    complete={completing}
                                />
                            )}
                        </CardContent>
                    </Card>
                </SidePaneMain>

                {/* ===== SAVE + SUMMARY ===== */}
                <SidePane id="planner.summary" side="right" label="Save and summary" grow={0.9} minWidth={260} paneScroll>
                    <div className="flex min-w-0 flex-col gap-5">
                        <SavePlanPanel
                            state={saveState}
                            name={name}
                            saving={updateSchedule.isPending}
                            discarding={deleteSchedule.isPending}
                            onNameChange={setName}
                            onSave={() => void save(true)}
                            onSaveDraft={() => void save(false)}
                            onDiscard={() => setConfirmDiscard(true)}
                        />

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
                                        {/* The column is narrow at xl, so the table scrolls
                                            sideways rather than clipping its last column. */}
                                        <div className="mt-2 overflow-x-auto">
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
                                        </div>
                                    </>
                                ) : (
                                    <p className="text-muted-fg text-sm">
                                        Generate a plan to see its makespan, machine load and job
                                        placement.
                                    </p>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </SidePane>
            </SidePaneLayout>

            {pickingStartDate && (
                <PlanStartDateDialog
                    initialDate={startDate}
                    regenerating={schedule !== null}
                    onGenerate={generate}
                    onDismiss={() => setPickingStartDate(false)}
                />
            )}

            {confirmDiscard && (
                <ConfirmDialog
                    title="Discard this plan?"
                    description="The generated draft is deleted. The jobs stay open in the backlog, so you can generate again."
                    confirmLabel="Discard plan"
                    cancelLabel="Keep it"
                    danger
                    onCancel={() => setConfirmDiscard(false)}
                    onConfirm={() => void discard()}
                />
            )}
        </ManagerShell>
    );
}
