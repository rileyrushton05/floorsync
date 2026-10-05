"use client";

import { Badge } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HeaderCount } from "@/components/ui/header-count";
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
import { InfoTooltip } from "@/components/ui/tooltip";
import { useAuth } from "@/core/auth/AuthProvider";
import { ConfirmDialog } from "@/core/feedback/ConfirmDialog";
import { reportBackendFailure, reportMutationError } from "@/core/feedback/reportMutationError";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { useSaveShortcut } from "@/core/keyboard/useSaveShortcut";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";
import {
    ReportingDateProvider,
    reportingDateStartsAt,
    useReportingDate,
} from "@/core/shell/ReportingDate";
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
import { SavePlanPanel, type SavePanelState } from "@/features/schedules/ui/SavePlanPanel";
import { ArrowLeftIcon, ArrowPathIcon, ExclamationCircleIcon } from "@heroicons/react/24/outline";
import { getLocalTimeZone, type CalendarDate } from "@internationalized/date";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
    type ScheduleStrategy,
    type ScheduleTimeline,
    type SchedulingIssue,
} from "../data/api";

/**
 * Planner: where a schedule is made.
 *
 * The flow is Schedules → "New schedule" → here: pick the open jobs, choose an
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

function formatPlanningDate(date: CalendarDate): string {
    return date.toDate(getLocalTimeZone()).toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

function PlanningStartNotice({ date }: { date: CalendarDate }) {
    return (
        <p className="mb-3 text-muted-fg text-xs">
            New schedules start on <strong className="font-semibold text-fg">{formatPlanningDate(date)}</strong>.
        </p>
    );
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
function GenerationState({ generation }: { generation: Generation }) {
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
            <ReportingDateProvider>
                <PlannerPageInner />
            </ReportingDateProvider>
        </Suspense>
    );
}

function PlannerPageInner() {
    const { date } = useReportingDate();
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
    const [name, setName] = useState("");
    const [confirmDiscard, setConfirmDiscard] = useState(false);

    const openJobs = useMemo(
        () => (jobsQuery.data ?? []).filter((job) => job.backlogStatus === "open"),
        [jobsQuery.data],
    );
    const openJobIds = useMemo(() => new Set(openJobs.map((job) => job.id)), [openJobs]);
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
    const busy = generating || writing;
    const canGenerate =
        !busy && selectedJobIds.length > 0 && validationQuery.data?.schedulable[strategy] !== false;
    const canSave = generation.status === "ready" && currentIsDraft && name.trim() !== "" && !writing;

    // A job can leave the backlog while this page is open. Settle the selection
    // during render so the next Generate press cannot send an id the page can
    // already see is no longer open.
    const currentSelection = selectedJobIds.filter((id) => openJobIds.has(id));
    if (currentSelection.length !== selectedJobIds.length) {
        setSelectedJobIds(currentSelection);
    }

    function generate() {
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
    const schedule = plan?.schedule ?? null;
    const machineName = (id: string) =>
        plan?.machines.find((machine) => machine.id === id)?.name ?? id;
    const allSelected = openJobs.length > 0 && selectedJobIds.length === openJobs.length;

    const saveState: SavePanelState =
        generation.status !== "ready" || currentScheduleId === null
            ? { kind: "empty" }
            : currentIsDraft
                ? { kind: "draft", scheduleId: currentScheduleId }
                : currentSummary && currentSummary.status !== "draft"
                    ? { kind: "saved", scheduleId: currentScheduleId, name: currentSummary.name, status: currentSummary.status }
                    : { kind: "empty" };

    return (
        <ManagerShell reportingDateProvider={false} showDatePicker actions={<>
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
                onPress={generate}
                aria-label={`${schedule ? "Regenerate" : "Generate"} plan starting ${formatPlanningDate(date)}`}
                isPending={generating}
                isDisabled={!generating && !canGenerate}
            >
                {generating ? "Generating…" : schedule ? "Regenerate plan" : "Generate plan"}
            </Button>
        </>}>

            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,2.2fr)_minmax(260px,0.9fr)]">
                {/* ===== WHAT WILL BE SCHEDULED ===== */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <span className="whitespace-nowrap">
                                Jobs to plan
                                <HeaderCount label={`${selectedJobIds.length} of ${openJobs.length} open jobs selected`}>
                                    {selectedJobIds.length}/{openJobs.length}
                                </HeaderCount>
                            </span>
                            <InfoTooltip label="About job selection">
                                Select the open jobs to include in this plan. Jobs already planned by a
                                confirmed schedule, completed or archived cannot be selected again.
                            </InfoTooltip>
                        </CardTitle>
                        {openJobs.length > 0 && (
                            <CardAction>
                                <Button
                                    intent="plain"
                                    size="sm"
                                    isDisabled={busy}
                                    onPress={() => setSelectedJobIds(allSelected ? [] : openJobs.map((job) => job.id))}
                                >
                                    {allSelected ? "Clear" : "Select all"}
                                </Button>
                            </CardAction>
                        )}
                    </CardHeader>
                    <CardContent>
                        <PlanningStartNotice date={date} />
                        <CheckboxGroup
                            aria-label="Jobs to schedule"
                            value={selectedJobIds}
                            isDisabled={busy}
                            onChange={(values) => setSelectedJobIds([...values])}
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

                        {openJobs.length === 0 && (
                            <p className="mt-3 text-muted-fg text-sm">
                                No open jobs are available to plan. {jobs.length === 0 && "Add a job first. "}
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
                            <GenerationState generation={generation} />
                        )}
                    </CardContent>
                </Card>

                {/* ===== SAVE + SUMMARY ===== */}
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
            </main>

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
