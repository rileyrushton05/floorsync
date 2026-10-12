"use client";

import { Badge } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { Note } from "@/components/ui/note";
import { PageMessage } from "@/core/feedback/PageMessage";
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { useLiveUpdates, type LiveStatus } from "@/core/live-updates/useLiveUpdates";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { SidePane, SidePaneLayout, SidePaneMain } from "@/core/shell/SidePanes";
import { buildJobColors } from "@/domains/scheduling/colors";
import { formatDuration } from "@/domains/scheduling/format";
import { timelineToPlan } from "@/domains/scheduling/timeline";
import { GanttChart } from "@/domains/scheduling/ui/GanttChart";
import { useTimelineZoom } from "@/domains/scheduling/ui/useTimelineZoom";
import { useJobSummaries } from "@/features/jobs/data/queries";
import { useActiveSimulation } from "@/features/operator/data/queries";
import type { SimulationPosition } from "@/features/schedules/data/api";
import { scheduleKeys } from "@/features/schedules/data/keys";
import {
    SIMULATION_FALLBACK_POLL_MS,
    useCreateSimulation,
    useRecordSimulationEvent,
    useScheduleSimulation,
    useScheduleSummaries,
    useScheduleTimeline,
} from "@/features/schedules/data/queries";
import {
    matchesScheduleQuery,
    scheduleDisplayName,
    strategyLabel,
    toScheduleRow,
} from "@/features/schedules/model/archive";
import {
    DEFAULT_SPEED,
    PLAYBACK_INTENT,
    PLAYBACK_LABEL,
    clamp,
    floorTotals,
    interpolatedMinutes,
    jobsAt,
    machinesAt,
    playbackStatus,
} from "@/features/schedules/model/simulation";
import { PlaybackControls } from "@/features/schedules/ui/PlaybackControls";
import { SimulationSchedulePanel } from "@/features/schedules/ui/SimulationSchedulePanel";
import { FloorTotalsStrip, JobProgressPanel, MachinesNowPanel } from "@/features/schedules/ui/SimulationFloor";
import { ArrowPathIcon, CalendarDaysIcon, SignalIcon, SignalSlashIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Simulation.
 *
 * The timeline is an immutable read of a confirmed schedule. Playback is not a
 * browser-only animation: starting, pausing, resetting, changing speed and
 * scrubbing each append a control to the simulation API's event log, so every
 * manager and operator watching sees the same clock, and the page can be
 * closed and reopened at the same point.
 *
 * Between reads the clock is carried forward locally at the speed the API
 * reported, so the play head moves smoothly. Changes made elsewhere arrive
 * over the live-update socket, which only nudges a re-read; while it is down
 * the page polls instead.
 *
 * Scrubbing previews locally while the pointer moves and records one `seeked`
 * control when it settles, so a drag is one event rather than hundreds.
 */

/** How long a keyboard or step scrub waits for more input before it is recorded. */
const SCRUB_SETTLE_MS = 350;
/** The repaint interval of the local clock while playing, in ms. */
const FRAME_MS = 50;

export default function SimulationPage() {
    return (
        <Suspense>
            <SimulationPageInner />
        </Suspense>
    );
}

function SimulationPageInner() {
    const queryClient = useQueryClient();
    const schedulesQuery = useScheduleSummaries();
    const jobsQuery = useJobSummaries();
    const linkedScheduleId = useSearchParams().get("schedule");
    const [userChoiceId, setUserChoiceId] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [startSpeed, setStartSpeed] = useState(DEFAULT_SPEED);
    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);
    const [highlightedMachineId, setHighlightedMachineId] = useState<string | null>(null);

    // ── Which schedule ─────────────────────────────────────────────────────
    const schedules = useMemo(() => schedulesQuery.data ?? [], [schedulesQuery.data]);
    const confirmedRows = useMemo(
        () => schedules.filter((schedule) => schedule.status === "confirmed").map(toScheduleRow)
            .sort((left, right) => Date.parse(right.confirmedAt ?? right.createdAt) - Date.parse(left.confirmedAt ?? left.createdAt)),
        [schedules],
    );
    const visibleRows = useMemo(
        () => confirmedRows.filter((row) => matchesScheduleQuery(row, query)),
        [confirmedRows, query],
    );
    const selectedOverrideId = userChoiceId ?? linkedScheduleId;
    const selectedId = confirmedRows.some((row) => row.id === selectedOverrideId)
        ? selectedOverrideId
        : confirmedRows[0]?.id ?? null;
    const selected = confirmedRows.find((row) => row.id === selectedId) ?? null;

    // ── Live sync ──────────────────────────────────────────────────────────
    // Keyed by schedule, so a status reported for the previous schedule's
    // socket never stops this one polling before its own socket is up.
    const [live, setLive] = useState<{ scheduleId: string | null; status: LiveStatus }>({
        scheduleId: null,
        status: "connecting",
    });
    const liveStatus: LiveStatus = live.scheduleId === selectedId ? live.status : "connecting";
    const simulationQuery = useScheduleSimulation(
        selectedId,
        liveStatus === "live" ? false : SIMULATION_FALLBACK_POLL_MS,
    );
    const simulation = simulationQuery.data ?? null;
    const refetchSimulation = useCallback(() => {
        if (selectedId === null) return;
        void queryClient.invalidateQueries({ queryKey: scheduleKeys.simulation(selectedId), exact: true });
    }, [queryClient, selectedId]);
    useLiveUpdates(
        simulation?.id ?? null,
        refetchSimulation,
        (status) => setLive({ scheduleId: selectedId, status }),
    );
    const operatorSimulation = useActiveSimulation(false).data ?? null;

    const timelineQuery = useScheduleTimeline(selectedId);
    const timeline = timelineQuery.data ?? null;
    const plan = useMemo(() => (timeline ? timelineToPlan(timeline) : null), [timeline]);
    const makespan = plan?.schedule.makespanMins ?? simulation?.makespan ?? 0;
    const timelineZoom = useTimelineZoom(Number.isFinite(makespan) ? makespan : 0);

    const createSimulation = useCreateSimulation();
    const recordEvent = useRecordSimulationEvent();

    // ── The clock ──────────────────────────────────────────────────────────
    const status = playbackStatus(simulation);
    const running = status === "running";
    const readAtMs = simulationQuery.dataUpdatedAt;
    const [nowMs, setNowMs] = useState(0);
    useEffect(() => {
        if (!running) return;
        let frame = 0;
        let last = 0;
        const tick = (time: number) => {
            if (time - last >= FRAME_MS) {
                last = time;
                setNowMs(Date.now());
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [running]);
    const serverMins = simulation === null ? 0 : interpolatedMinutes(simulation, readAtMs, nowMs);

    // A scrub in progress: shown immediately, recorded when it settles.
    const [scrubMins, setScrubMins] = useState<number | null>(null);
    const scrubGeneration = useRef(0);
    const latestScrub = useRef<number | null>(null);
    const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(settleTimer.current), []);

    const displayMins = scrubMins ?? serverMins;
    const started = status !== "not_started" || scrubMins !== null;
    const persistedSpeed = Number(simulation?.speed);
    const speed = (status === "running" || status === "paused") && Number.isFinite(persistedSpeed)
        ? persistedSpeed
        : startSpeed;
    const controlsPending = createSimulation.isPending || (recordEvent.isPending && recordEvent.variables?.eventType !== "seeked");

    // A schedule has one simulation; the first control on a fresh schedule
    // creates it. Remembered per schedule so two quick presses cannot create
    // it twice and trip the API's one-per-schedule conflict.
    const creating = useRef<{ scheduleId: string; promise: Promise<SimulationPosition> } | null>(null);
    function ensureSimulation(): Promise<SimulationPosition> | null {
        if (selectedId === null) return null;
        if (simulation !== null) return Promise.resolve(simulation);
        if (creating.current?.scheduleId !== selectedId) {
            const promise = createSimulation.mutateAsync(selectedId);
            creating.current = { scheduleId: selectedId, promise };
            promise.catch(() => {
                if (creating.current?.promise === promise) creating.current = null;
            });
        }
        return creating.current.promise;
    }

    // ── Completion ─────────────────────────────────────────────────────────
    // The API derives completion from elapsed time but records it only when
    // asked. Re-read the position when the local clock says the plan should
    // have ended, then turn that derived boundary into one durable event.
    useEffect(() => {
        if (simulation === null || !simulation.is_running || simulation.is_complete) return;
        const speedPerSecond = Number(simulation.speed);
        if (!Number.isFinite(speedPerSecond) || speedPerSecond <= 0) return;
        const remainingMs = ((simulation.makespan - simulation.simulated_time) / speedPerSecond) * 1000;
        const timer = setTimeout(refetchSimulation, Math.max(0, remainingMs - (Date.now() - readAtMs)) + 150);
        return () => clearTimeout(timer);
    }, [readAtMs, refetchSimulation, simulation]);

    const completionRequested = useRef<string | null>(null);
    useEffect(() => {
        if (simulation === null) return;
        if (!simulation.is_complete) {
            // Reset or scrubbed back: a later finish must be recorded again.
            if (completionRequested.current === simulation.id) completionRequested.current = null;
            return;
        }
        if (simulation.status !== "running" || completionRequested.current === simulation.id) return;
        completionRequested.current = simulation.id;
        recordEvent.mutate(
            { simulationId: simulation.id, eventType: "completed" },
            {
                onError: (error) => {
                    // Another tab recorded it first; re-read rather than alarm anyone.
                    if (error instanceof ApiError && error.status === 409) {
                        refetchSimulation();
                        return;
                    }
                    completionRequested.current = null;
                    reportMutationError(error);
                },
            },
        );
    }, [recordEvent, refetchSimulation, simulation]);

    // A simulation that ran out while nobody had it open is still `running` in
    // the log, so operators would follow it forever. Any manager's visit
    // records the finish it reached, which hands the floor on.
    const settledOperatorSimulation = useRef<string | null>(null);
    useEffect(() => {
        if (
            operatorSimulation === null
            || operatorSimulation.id === simulation?.id
            || !operatorSimulation.is_complete
            || operatorSimulation.status !== "running"
            || settledOperatorSimulation.current === operatorSimulation.id
        ) return;
        settledOperatorSimulation.current = operatorSimulation.id;
        // Best effort and unrequested, so a refusal is not the manager's to see.
        recordEvent.mutate({ simulationId: operatorSimulation.id, eventType: "completed" }, { onError: () => undefined });
    }, [operatorSimulation, recordEvent, simulation?.id]);

    // ── Controls ───────────────────────────────────────────────────────────
    async function togglePlayback() {
        if (controlsPending) return;
        try {
            const current = await ensureSimulation();
            if (current === null) return;
            const currentStatus = playbackStatus(current);
            if (currentStatus === "running") {
                await recordEvent.mutateAsync({ simulationId: current.id, eventType: "paused" });
            } else if (currentStatus === "paused") {
                await recordEvent.mutateAsync({ simulationId: current.id, eventType: "resumed", speed });
            } else {
                // Finished: play again from the top.
                if (currentStatus === "complete") {
                    await recordEvent.mutateAsync({ simulationId: current.id, eventType: "reset" });
                }
                await recordEvent.mutateAsync({ simulationId: current.id, eventType: "started", speed });
            }
        } catch (error) {
            reportMutationError(error);
        }
    }

    async function resetPlayback() {
        if (simulation === null || controlsPending) return;
        cancelScrub();
        try {
            await recordEvent.mutateAsync({ simulationId: simulation.id, eventType: "reset" });
        } catch (error) {
            reportMutationError(error);
        }
    }

    async function changeSpeed(nextSpeed: number) {
        setStartSpeed(nextSpeed);
        if (simulation === null || (status !== "running" && status !== "paused")) return;
        try {
            await recordEvent.mutateAsync({ simulationId: simulation.id, eventType: "speed_changed", speed: nextSpeed });
        } catch (error) {
            reportMutationError(error);
        }
    }

    function cancelScrub() {
        clearTimeout(settleTimer.current);
        scrubGeneration.current += 1;
        latestScrub.current = null;
        setScrubMins(null);
    }

    /** Show `mins` now; record it once input settles. */
    function previewScrub(mins: number) {
        const target = clamp(mins, 0, makespan);
        scrubGeneration.current += 1;
        latestScrub.current = target;
        setScrubMins(target);
        clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => void commitScrub(), SCRUB_SETTLE_MS);
    }

    /** Record the latest previewed minute as one seek. */
    async function commitScrub() {
        clearTimeout(settleTimer.current);
        const target = latestScrub.current;
        if (target === null) return;
        latestScrub.current = null;
        const generation = scrubGeneration.current;
        try {
            const current = await ensureSimulation();
            if (current === null) return;
            await recordEvent.mutateAsync({ simulationId: current.id, eventType: "seeked", position: target });
        } catch (error) {
            reportMutationError(error);
        } finally {
            // Keep showing the preview if the manager scrubbed again meanwhile.
            if (generation === scrubGeneration.current) setScrubMins(null);
        }
    }

    // Space plays and pauses, unless something focused already owns the key.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.code !== "Space" || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
            const target = event.target as HTMLElement | null;
            if (target?.closest("input, textarea, select, button, a, [role=slider], [role=row], [role=gridcell], [contenteditable=true]")) return;
            event.preventDefault();
            void togglePlaybackRef.current();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    const togglePlaybackRef = useRef(togglePlayback);
    useEffect(() => {
        togglePlaybackRef.current = togglePlayback;
    });

    // ── Derived floor state ────────────────────────────────────────────────
    const colors = useMemo(() => buildJobColors(jobsQuery.data ?? plan?.jobs ?? []), [jobsQuery.data, plan]);
    const jobNames = useMemo(() => new Map(plan?.jobs.map((job) => [job.id, job.name]) ?? []), [plan]);
    const jobName = useCallback((jobId: string) => jobNames.get(jobId) ?? jobId, [jobNames]);
    const floorMins = started ? displayMins : null;
    const machinesNow = useMemo(
        () => (plan ? machinesAt(plan.schedule, plan.machines, floorMins) : []),
        [floorMins, plan],
    );
    const jobsNow = useMemo(() => (plan ? jobsAt(plan.schedule, jobName, floorMins) : []), [floorMins, jobName, plan]);
    const totals = plan ? floorTotals(plan.schedule, machinesNow, jobsNow, floorMins) : null;

    // ── Page states ────────────────────────────────────────────────────────
    if (schedulesQuery.error instanceof ApiError && schedulesQuery.error.isForbidden) {
        return (
            <ManagerPageState title="This needs a manager account">
                Running a simulation is restricted to managers.
            </ManagerPageState>
        );
    }
    if (schedulesQuery.error && !schedulesQuery.data) {
        return (
            <ManagerPageState title="Could not load schedules" error>
                <p>{errorMessage(schedulesQuery.error)}</p>
                <Button intent="outline" size="sm" className="mt-3" onPress={() => void schedulesQuery.refetch()}>
                    <ArrowPathIcon /> Try again
                </Button>
            </ManagerPageState>
        );
    }
    if (schedulesQuery.isPending) {
        return <ManagerPageState title="Loading schedules…">Reading confirmed schedules from the API.</ManagerPageState>;
    }

    const schedulesLink = (
        <Link href="/manager/schedules" className={buttonStyles({ intent: "outline" })}>
            <CalendarDaysIcon /> All schedules
        </Link>
    );

    if (confirmedRows.length === 0) {
        return (
            <ManagerShell actions={schedulesLink}>
                <main className="flex flex-1 flex-col items-center justify-center gap-4 p-5">
                    <PageMessage title={schedules.length === 0 ? "No schedules yet" : "No confirmed schedules to simulate"}>
                        {schedules.length === 0
                            ? "Plan some open jobs in the Planner, then save the schedule to run it here."
                            : "Only confirmed schedules can be simulated. Save a draft from the Planner, or confirm one on the Schedules page."}
                    </PageMessage>
                    <Link href="/manager/planner" className={buttonStyles()}>Open the Planner</Link>
                </main>
            </ManagerShell>
        );
    }

    const operatorsFollowOther = operatorSimulation !== null
        && operatorSimulation.schedule_id !== selectedId
        && operatorSimulation.status !== "not_started";
    const operatorScheduleName = (() => {
        const row = confirmedRows.find((candidate) => candidate.id === operatorSimulation?.schedule_id);
        return row ? `“${scheduleDisplayName(row)}”` : "another schedule";
    })();

    return (
        <ManagerShell actions={schedulesLink}>
            <SidePaneLayout>
                <SidePane id="simulation.schedules" side="left" label="Schedules" grow={0.7} minWidth={280}>
                    <SimulationSchedulePanel
                        total={confirmedRows.length}
                        rows={visibleRows}
                        selectedId={selectedId}
                        operatorScheduleId={operatorSimulation?.status === "not_started" ? null : operatorSimulation?.schedule_id ?? null}
                        query={query}
                        onQueryChange={setQuery}
                        onSelect={(id) => {
                            if (id === selectedId) return;
                            cancelScrub();
                            setHighlightedJobId(null);
                            setUserChoiceId(id);
                        }}
                    />
                </SidePane>
                <SidePaneMain grow={2.3}>
                    <div className="flex min-w-0 flex-col gap-5">
                        {schedulesQuery.error && (
                            <Note intent="warning" role="status">
                                Showing the last schedules that loaded. Could not refresh: {errorMessage(schedulesQuery.error)}
                            </Note>
                        )}

                        <Card className="min-w-0">
                            <CardHeader className="gap-1">
                                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                                    <CardTitle className={`truncate text-2xl ${selected?.name ? "" : "text-muted-fg italic"}`}>
                                        {selected ? scheduleDisplayName(selected) : "–"}
                                    </CardTitle>
                                    <Badge intent={PLAYBACK_INTENT[status]}>{PLAYBACK_LABEL[status]}</Badge>
                                    {simulation !== null && <LiveBadge status={liveStatus} />}
                                </div>
                                <p className="text-muted-fg text-sm">
                                    {selected ? strategyLabel(selected.strategy) : ""}
                                    {plan && ` · ${count(plan.jobs.length, "job")} on ${count(machinesNow.length, "machine")} · ${count(plan.schedule.ops.length, "operation")} · makespan ${formatDuration(makespan)}`}
                                </p>
                                <CardAction>
                                    {selected && (
                                        <Link
                                            href={`/manager/schedules?schedule=${encodeURIComponent(selected.id)}`}
                                            className={buttonStyles({ intent: "plain", size: "sm" })}
                                        >
                                            Schedule details
                                        </Link>
                                    )}
                                </CardAction>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-4">
                                {simulationQuery.error && (
                                    <Note intent="danger" role="alert">
                                        <strong>Could not read the simulation&apos;s position.</strong>{" "}
                                        {errorMessage(simulationQuery.error)}
                                    </Note>
                                )}
                                {operatorsFollowOther && (
                                    <Note intent="info" role="status">
                                        Operator screens are following {operatorScheduleName}, not this schedule.
                                        Reset that simulation to hand the floor to this one.
                                    </Note>
                                )}

                                {plan ? (
                                    <>
                                        <PlaybackControls
                                            status={status}
                                            nowMins={displayMins}
                                            makespanMins={makespan}
                                            speed={speed}
                                            pending={controlsPending || simulationQuery.isPending}
                                            canReset={simulation !== null && (status !== "not_started" || serverMins > 0)}
                                            onTogglePlay={() => void togglePlayback()}
                                            onReset={() => void resetPlayback()}
                                            onStep={(delta) => previewScrub(displayMins + delta)}
                                            onSpeedChange={(next) => void changeSpeed(next)}
                                            onScrub={previewScrub}
                                            onScrubEnd={(mins) => {
                                                latestScrub.current = clamp(mins, 0, makespan);
                                                void commitScrub();
                                            }}
                                        />
                                        {totals && <FloorTotalsStrip totals={totals} started={started} />}
                                        <GanttChart
                                            machines={plan.machines}
                                            jobs={plan.jobs}
                                            schedule={plan.schedule}
                                            colors={colors}
                                            mode="simulation"
                                            nowMins={floorMins}
                                            selectedJobId={highlightedJobId}
                                            highlightedMachineId={highlightedMachineId}
                                            zoom={timelineZoom}
                                            followNow={running && scrubMins === null}
                                            onSelectJob={(jobId) => setHighlightedJobId((previous) => (previous === jobId ? null : jobId))}
                                            onScrub={previewScrub}
                                            onScrubEnd={() => void commitScrub()}
                                        />
                                    </>
                                ) : timelineQuery.error ? (
                                    <PageMessage title="This schedule's timeline could not be read" tone="danger">
                                        <p>{errorMessage(timelineQuery.error)}</p>
                                        <Button intent="outline" size="sm" className="mt-3" onPress={() => void timelineQuery.refetch()}>
                                            <ArrowPathIcon /> Try again
                                        </Button>
                                    </PageMessage>
                                ) : (
                                    <p className="py-10 text-center text-muted-fg text-sm" role="status">
                                        Reading this schedule&apos;s timeline…
                                    </p>
                                )}
                            </CardContent>
                        </Card>

                        {plan && (
                            <div className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                                <MachinesNowPanel
                                    machines={machinesNow}
                                    colors={colors}
                                    jobName={jobName}
                                    highlightedMachineId={highlightedMachineId}
                                    onHighlightMachine={setHighlightedMachineId}
                                />
                                <JobProgressPanel
                                    jobs={jobsNow}
                                    colors={colors}
                                    selectedJobId={highlightedJobId}
                                    onSelectJob={setHighlightedJobId}
                                />
                            </div>
                        )}
                    </div>
                </SidePaneMain>
            </SidePaneLayout>
        </ManagerShell>
    );
}

function count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const LIVE_BADGE: Record<LiveStatus, { intent: "success" | "warning" | "danger"; label: string; title: string }> = {
    live: { intent: "success", label: "Live", title: "Changes from other managers appear immediately." },
    connecting: { intent: "warning", label: "Connecting…", title: "Checking for changes every few seconds until the live connection is up." },
    offline: { intent: "danger", label: "Offline", title: "The live connection is down; checking for changes every few seconds." },
};

function LiveBadge({ status }: { status: LiveStatus }) {
    const badge = LIVE_BADGE[status];
    return (
        <Badge intent={badge.intent} title={badge.title}>
            {status === "offline" ? <SignalSlashIcon data-slot="icon" aria-hidden /> : <SignalIcon data-slot="icon" aria-hidden />}
            {badge.label}
        </Badge>
    );
}
