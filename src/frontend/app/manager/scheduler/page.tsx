"use client";

import { ArrowPathIcon, ExclamationCircleIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ApiError,
    type Job,
    type MachineSummary,
    type ScheduleStrategy,
    type ScheduleTimeline,
    type SchedulingIssue,
    fetchJobs,
    fetchMachines,
    fetchScheduleTimeline,
    fetchSchedules,
    requestSchedule,
} from "@/app/_lib/api";
import { errorMessage, type LoadState } from "@/app/_lib/load-state";
import { useAuth } from "@/app/_components/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { GanttChart } from "../_components/GanttChart";
import { ManagerTopbar } from "../_components/ManagerTopbar";
import { buildJobColors, jobColor } from "../_lib/colors";
import { GenerationTimeout, awaitGeneration } from "../_lib/generation";
import { formatDuration, formatOffset } from "../_lib/scheduling";
import { timelineToPlan } from "../_lib/timeline";

/**
 * Schedule builder.
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
 * Nothing here computes a time. `_lib/timeline.ts` translates the timeline into
 * the `GeneratedSchedule` the chart already draws — renaming and regrouping
 * only — so what is on screen is the engine's arithmetic rather than a second
 * opinion about it.
 */

/** What is in the database to be scheduled, shown before a run is started. */
interface Floor {
    jobs: Job[];
    machines: MachineSummary[];
}

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
    | { status: "unavailable" }
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

/** The first segment of a UUID: enough to quote a run, short enough to read. */
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
        <div className="flex min-h-dvh flex-col bg-bg text-fg">
            <ManagerTopbar />
            <main className="flex flex-1 items-center justify-center p-5">
                <div className="w-full max-w-prose">
                    {danger ? (
                        <Note intent="danger" role="alert">
                            <div>
                                <strong>{title}</strong>
                                <div className="mt-1">{children}</div>
                                {onRetry && (
                                    <Button intent="outline" size="sm" className="mt-3" onPress={onRetry}>
                                        <ArrowPathIcon />
                                        Try again
                                    </Button>
                                )}
                            </div>
                        </Note>
                    ) : (
                        <div className="rounded-lg border border-dashed bg-overlay p-8 text-center">
                            <h2 className="font-semibold text-lg">{title}</h2>
                            <div className="mt-2 text-muted-fg text-sm">{children}</div>
                        </div>
                    )}
                </div>
            </main>
        </div>
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
                </Note>
            );

        case "unavailable":
            return (
                <Note intent="warning" role="alert" indicator={false}>
                    <strong>The scheduling engine is not installed</strong>
                    <p className="mt-1">
                        The worker reached the run but has no learned runtime to do it with, so
                        nothing was written. The worker image installs it; a worker started outside
                        Docker needs <code>uv sync --extra resched</code>.
                    </p>
                </Note>
            );

        case "timedOut":
            return (
                <Note intent="warning" role="alert" indicator={false}>
                    <strong>Nothing picked up the run</strong>
                    <p className="mt-1">
                        The API queued run <code>{shortId(generation.generationId)}</code> and
                        accepted it, but three minutes later no worker had reported starting it. A
                        queued command and a command nothing is listening for look identical from
                        here, so this most likely means the scheduling worker is not running —
                        check <code>docker compose ps worker</code>.
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
                        engine assigns every operation in the database to a compatible machine and
                        places it on the earliest slot that respects the dependencies between them.
                        The run happens on a worker, so this page will wait for it.
                    </p>
                </div>
            );
    }
}

export default function SchedulerPage() {
    const { token, user } = useAuth();

    const [floor, setFloor] = useState<LoadState<Floor>>({ status: "loading" });
    const [floorAttempt, setFloorAttempt] = useState(0);
    const [generation, setGeneration] = useState<Generation>({ status: "idle" });
    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);
    const [strategy, setStrategy] = useState<ScheduleStrategy>("resched");

    // One run at a time. Held in a ref rather than state because nothing renders
    // from it — it exists so a second Generate, or leaving the page, can call
    // off the first run's polling loop.
    const runRef = useRef<AbortController | null>(null);
    useEffect(() => () => runRef.current?.abort(), []);

    // What is in the database to be scheduled. Read once; the engine reads the
    // same rows when it runs, so this is also the honest preview of its input.
    useEffect(() => {
        if (token === null) return;
        let current = true;
        Promise.all([fetchJobs(token), fetchMachines(token)])
            .then(([jobs, machines]) => {
                if (!current) return;
                setFloor({
                    status: "ready",
                    value: { jobs: jobs.items, machines: machines.items },
                });
            })
            .catch((error: unknown) => {
                if (!current) return;
                // These endpoints are manager-only, so a 403 means the account is
                // an operator rather than that anything is broken. A 401 is left
                // alone: the API client signs out on any unauthenticated response,
                // which lets RequireManager bounce to the login screen on its own.
                if (error instanceof ApiError && error.isForbidden) {
                    setFloor({ status: "forbidden" });
                    return;
                }
                setFloor({ status: "error", message: errorMessage(error) });
            });
        return () => {
            current = false;
        };
    }, [floorAttempt, token]);

    // Open on the most recent stored plan, so arriving here shows the current
    // schedule rather than an empty frame. Failures are swallowed: this is a
    // convenience, and the empty state plus a working Generate is still correct
    // without it.
    useEffect(() => {
        if (token === null) return;
        let current = true;
        fetchSchedules(token)
            .then(async (summaries) => {
                const newest = summaries[0];
                if (!newest || !current) return;
                const timeline = await fetchScheduleTimeline(newest.id, token);
                if (!current) return;
                // Only if nothing has been started meanwhile: this read races a
                // manager who presses Generate straight away, and their run wins.
                setGeneration((existing) =>
                    existing.status === "idle"
                        ? {
                              status: "ready",
                              scheduleId: newest.id,
                              timeline,
                              createdAt: newest.created_at,
                          }
                        : existing,
                );
            })
            .catch(() => {});
        return () => {
            current = false;
        };
    }, [token]);

    const generate = useCallback(() => {
        if (token === null) return;

        runRef.current?.abort();
        const controller = new AbortController();
        runRef.current = controller;
        const { signal } = controller;
        setHighlightedJobId(null);

        void (async () => {
            try {
                const accepted = await requestSchedule(new Date().toISOString(), token, strategy);
                if (signal.aborted) return;
                setGeneration({ status: "queued", generationId: accepted.id });

                const finished = await awaitGeneration(accepted.id, token, {
                    signal,
                    onProgress: (progress) => {
                        if (progress.status === "running") {
                            setGeneration({ status: "running", generationId: accepted.id });
                        }
                    },
                });
                if (signal.aborted) return;

                switch (finished.status) {
                    case "completed": {
                        const scheduleId = finished.schedule_id;
                        if (!scheduleId) {
                            setGeneration({
                                status: "failed",
                                message:
                                    "The run completed but reported no schedule to open, so there is nothing to draw.",
                            });
                            return;
                        }
                        setGeneration({ status: "drawing", scheduleId });
                        const timeline = await fetchScheduleTimeline(scheduleId, token);
                        if (signal.aborted) return;
                        setGeneration({ status: "ready", scheduleId, timeline, createdAt: null });
                        return;
                    }
                    case "rejected":
                        setGeneration({ status: "rejected", issues: finished.issues ?? [] });
                        return;
                    case "unavailable":
                        setGeneration({ status: "unavailable" });
                        return;
                    default:
                        setGeneration({
                            status: "failed",
                            message:
                                "The worker did not finish the run. The API deliberately does not forward the exception, so the worker's logs are where the reason is.",
                        });
                }
            } catch (error) {
                if (signal.aborted) return;
                if (error instanceof GenerationTimeout) {
                    setGeneration({ status: "timedOut", generationId: error.generationId });
                    return;
                }
                setGeneration({ status: "error", message: errorMessage(error) });
            }
        })();
    }, [token, strategy]);

    const retryFloor = useCallback(() => {
        setFloor({ status: "loading" });
        setFloorAttempt((count) => count + 1);
    }, []);

    const plan = useMemo(
        () => (generation.status === "ready" ? timelineToPlan(generation.timeline) : null),
        [generation],
    );

    // Colour is keyed to a job's position in the backlog rather than to its
    // position in a plan, so the swatch beside a job on the left is the colour
    // it wears on the chart, and a plan containing fewer jobs never repaints the
    // ones that remain. The plan's own jobs are the fallback for when the
    // backlog could not be read.
    const backlog = floor.status === "ready" ? floor.value.jobs : null;
    const colors = useMemo(
        () => buildJobColors(backlog ?? plan?.jobs ?? []),
        [backlog, plan],
    );

    const busy = IN_FLIGHT.has(generation.status);

    function toggleHighlight(jobId: string) {
        setHighlightedJobId((previous) => (previous === jobId ? null : jobId));
    }

    if (floor.status === "loading") {
        return (
            <Placeholder title="Loading the floor…">
                Reading <code>GET /api/v1/jobs</code> and <code>GET /api/v1/machines</code>.
            </Placeholder>
        );
    }

    if (floor.status === "forbidden") {
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

    if (floor.status === "error") {
        return (
            <Placeholder title="Could not read the floor." danger onRetry={retryFloor}>
                <p>{floor.message}</p>
                <p className="mt-1 text-muted-fg">
                    Check the API is running and that the database has been migrated.
                </p>
            </Placeholder>
        );
    }

    const { jobs, machines } = floor.value;
    const activeMachines = machines.filter((machine) => machine.active);
    const schedule = plan?.schedule ?? null;
    const machineName = (id: string) =>
        plan?.machines.find((machine) => machine.id === id)?.name ?? id;

    return (
        <div className="flex min-h-dvh flex-col bg-bg text-fg">
            <ManagerTopbar>
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
                    onPress firing while pending, and keeps the control focusable
                    and announced as busy instead of silently going dead. */}
                <Button onPress={generate} isPending={busy}>
                    {busy ? "Generating…" : schedule ? "Regenerate schedule" : "Generate schedule"}
                </Button>
            </ManagerTopbar>

            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,2.2fr)_minmax(260px,0.9fr)]">
                {/* ===== WHAT WILL BE SCHEDULED ===== */}
                <Card>
                    <CardHeader className="flex-row items-center gap-2.5">
                        <CardTitle>Released to schedule</CardTitle>
                        <Badge intent="secondary">
                            {jobs.length} / {jobs.length}
                        </Badge>
                    </CardHeader>
                    <CardContent>
                        <Note intent="info">
                            Generation runs over <strong>every operation in the database</strong>.
                            Scoping a run to a chosen subset of jobs is not something the API
                            supports yet, so the list below is what will be planned rather than a
                            choice.
                        </Note>

                        <CheckboxGroup
                            aria-label="Jobs that will be scheduled"
                            value={jobs.map((job) => job.id)}
                            isDisabled
                            className="mt-3"
                        >
                            {jobs.map((job) => (
                                <CheckboxField
                                    key={job.id}
                                    value={job.id}
                                    className="rounded-lg p-2 transition-colors hover:bg-secondary"
                                >
                                    <Checkbox>
                                        <span className="flex min-w-0 flex-col gap-0.5">
                                            <span className="flex items-center gap-2">
                                                <span
                                                    className="size-3 shrink-0 rounded-full"
                                                    style={{ background: jobColor(colors, job.id).fill }}
                                                />
                                                <span className="font-semibold text-sm">{job.name}</span>
                                            </span>
                                            <span className="text-muted-fg text-xs">
                                                {shortId(job.id)}
                                            </span>
                                        </span>
                                    </Checkbox>
                                </CheckboxField>
                            ))}
                        </CheckboxGroup>

                        {jobs.length === 0 && (
                            <p className="mt-3 text-muted-fg text-sm">
                                No jobs in the database.{" "}
                                <Link href="/manager/jobs" className="text-primary">
                                    Add one →
                                </Link>
                            </p>
                        )}

                        <Separator className="my-3" />
                        <div className="text-muted-fg text-sm">
                            {jobs.length} {jobs.length === 1 ? "job" : "jobs"} ·{" "}
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
                    <CardHeader className="flex-row items-center justify-between gap-3">
                        <CardTitle>Generated plan</CardTitle>
                        {generation.status === "ready" && schedule && (
                            <span className="text-muted-fg text-sm">
                                makespan {formatDuration(schedule.makespanMins)} ·{" "}
                                {schedule.ops.length} operations ·{" "}
                                {generation.createdAt === null
                                    ? "generated just now"
                                    : formatCreated(generation.createdAt)}
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
                                                        <span
                                                            className="size-3 shrink-0 rounded-full"
                                                            style={{ background: jobColor(colors, id).fill }}
                                                        />
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
                                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#15803D] px-4 py-2 font-semibold text-sm text-[#DCFCE7] transition-colors hover:bg-[#166534] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#15803D]"
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
        </div>
    );
}
