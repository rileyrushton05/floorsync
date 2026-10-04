"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Note } from "@/components/ui/note";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
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
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { buildJobColors } from "@/domains/scheduling/colors";
import { formatDuration, formatOffset } from "@/domains/scheduling/format";
import { timelineToPlan } from "@/domains/scheduling/timeline";
import type { GeneratedSchedule } from "@/domains/scheduling/types";
import { GanttChart } from "@/domains/scheduling/ui/GanttChart";
import { JobDot } from "@/domains/scheduling/ui/JobDot";
import { useTimelineZoom } from "@/domains/scheduling/ui/useTimelineZoom";
import { useJobSummaries } from "@/features/jobs/data/queries";
import {
    useCreateSimulation,
    useRecordSimulationEvent,
    useScheduleSimulation,
    useScheduleSummaries,
    useScheduleTimeline,
} from "@/features/schedules/data/queries";
import { toScheduleOption } from "@/features/schedules/model/schedule";
import { ScheduleBar } from "@/features/schedules/ui/ScheduleBar";
import { ArrowPathIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Simulation.
 *
 * The timeline is an immutable read of a confirmed schedule. Playback is not a
 * browser-only animation: creating, starting, pausing, resetting and changing
 * speed append controls to the simulation API's event log. The position below
 * is recovered on entry and refreshed while it is running, so a manager can
 * safely close the page and continue from the same point later.
 */

const SPEEDS = [
    { value: 1, label: "1×", hint: "1 min/s" },
    { value: 10, label: "10×", hint: "10 min/s" },
    { value: 60, label: "60×", hint: "1 hr/s" },
];

type MachineActivity =
    | { kind: "running"; jobId: string; opName: string; opIndex: number; opTotal: number; progressPct: number; endMins: number }
    | { kind: "idle"; nextStartMins: number | null }
    | { kind: "finished" };

function machineActivity(schedule: GeneratedSchedule, machineId: string, nowMins: number): MachineActivity {
    const ops = schedule.ops.filter((op) => op.machineId === machineId);
    const running = ops.find((op) => op.startMins <= nowMins && op.endMins > nowMins);
    if (running) {
        return {
            kind: "running",
            jobId: running.jobId,
            opName: running.opName,
            opIndex: running.opIndex,
            opTotal: running.opTotal,
            progressPct: ((nowMins - running.startMins) / (running.endMins - running.startMins)) * 100,
            endMins: running.endMins,
        };
    }
    const upcoming = ops.filter((op) => op.startMins > nowMins);
    if (upcoming.length === 0) return { kind: "finished" };
    return { kind: "idle", nextStartMins: Math.min(...upcoming.map((op) => op.startMins)) };
}

const ACTIVITY_INTENT = {
    running: "info",
    idle: "warning",
    finished: "success",
} as const;

const STATE_INTENT = {
    Done: "success",
    Running: "info",
    Waiting: "secondary",
} as const;

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

export default function SimulationPage() {
    const [startSpeed, setStartSpeed] = useState(10);
    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);
    const [hoveredMachineId, setHoveredMachineId] = useState<string | null>(null);
    const [userChoiceId, setUserChoiceId] = useState<string | null>(null);
    const completionRequested = useRef<string | null>(null);

    const { user } = useAuth();
    const schedulesQuery = useScheduleSummaries();
    const jobsQuery = useJobSummaries();
    const searchParams = useSearchParams();
    const linkedScheduleId = searchParams.get("schedule");
    const schedules = useMemo(() => schedulesQuery.data ?? [], [schedulesQuery.data]);
    const confirmedSchedules = useMemo(
        () => schedules.filter((schedule) => schedule.status === "confirmed"),
        [schedules],
    );
    const selectedOverrideId = userChoiceId ?? linkedScheduleId;
    const selectedId = confirmedSchedules.some((schedule) => schedule.id === selectedOverrideId)
        ? selectedOverrideId
        : confirmedSchedules[0]?.id ?? null;
    const timelineQuery = useScheduleTimeline(selectedId);
    const simulationQuery = useScheduleSimulation(selectedId);
    const createSimulation = useCreateSimulation();
    const recordEvent = useRecordSimulationEvent();
    const timeline = timelineQuery.data ?? null;
    const plan = useMemo(() => (timeline ? timelineToPlan(timeline) : null), [timeline]);
    const activeSchedule = plan?.schedule ?? null;
    const timelineZoom = useTimelineZoom(activeSchedule?.makespanMins ?? 0);
    const scheduleOptions = useMemo(() => confirmedSchedules.map(toScheduleOption), [confirmedSchedules]);
    const simulation = simulationQuery.data ?? null;
    const makespan = activeSchedule?.makespanMins ?? 0;
    const simMins = Math.max(0, Math.min(simulation?.simulated_time ?? 0, makespan));
    const persistedSpeed = Number(simulation?.speed);
    const speed = simulation?.status === "not_started" || !Number.isFinite(persistedSpeed)
        ? startSpeed
        : persistedSpeed;
    const started = simulation !== null && simulation.status !== "not_started";
    const atEnd = simulation?.is_complete ?? false;
    const running = simulation?.is_running === true && !atEnd;
    const controlsPending = createSimulation.isPending || recordEvent.isPending;

    // The backend derives completion from elapsed time, but records it only
    // when asked. This turns that derived boundary into one durable event.
    useEffect(() => {
        if (
            simulation === null
            || !simulation.is_complete
            || simulation.status === "complete"
            || completionRequested.current === simulation.id
        ) return;
        completionRequested.current = simulation.id;
        recordEvent.mutate(
            { simulationId: simulation.id, eventType: "completed" },
            {
                onError: (error) => {
                    completionRequested.current = null;
                    reportMutationError(error);
                },
            },
        );
    }, [recordEvent, simulation]);

    async function changeSpeed(nextSpeed: number) {
        setStartSpeed(nextSpeed);
        if (simulation === null || !["running", "paused"].includes(simulation.status)) return;
        try {
            await recordEvent.mutateAsync({
                simulationId: simulation.id,
                eventType: "speed_changed",
                speed: nextSpeed,
            });
        } catch (error) {
            reportMutationError(error);
        }
    }

    async function togglePlayback() {
        if (selectedId === null) return;
        try {
            if (simulation === null) {
                const created = await createSimulation.mutateAsync(selectedId);
                await recordEvent.mutateAsync({
                    simulationId: created.id,
                    eventType: "started",
                    speed,
                });
                return;
            }
            if (simulation.status === "complete" || simulation.is_complete) {
                await recordEvent.mutateAsync({ simulationId: simulation.id, eventType: "reset" });
                await recordEvent.mutateAsync({
                    simulationId: simulation.id,
                    eventType: "started",
                    speed,
                });
                return;
            }
            if (simulation.status === "running") {
                await recordEvent.mutateAsync({ simulationId: simulation.id, eventType: "paused" });
                return;
            }
            await recordEvent.mutateAsync({
                simulationId: simulation.id,
                eventType: simulation.status === "paused" ? "resumed" : "started",
                speed,
            });
        } catch (error) {
            reportMutationError(error);
        }
    }

    async function resetPlayback() {
        if (simulation === null) return;
        try {
            await recordEvent.mutateAsync({ simulationId: simulation.id, eventType: "reset" });
        } catch (error) {
            reportMutationError(error);
        }
    }

    if (schedulesQuery.isPending) {
        return <Placeholder title="Loading schedules…">Preparing the manager simulation view.</Placeholder>;
    }

    if (schedulesQuery.error instanceof ApiError && schedulesQuery.error.isForbidden) {
        return (
            <Placeholder title="This needs a manager account">
                <p>You are signed in as <strong>{user?.name}</strong> ({user?.role}).</p>
                <p className="mt-2">Sign in with a manager account to run a simulation.</p>
            </Placeholder>
        );
    }

    if (schedulesQuery.error) {
        return (
            <Placeholder title="Could not load schedules." danger onRetry={() => void schedulesQuery.refetch()}>
                <p>{errorMessage(schedulesQuery.error)}</p>
            </Placeholder>
        );
    }

    if (schedules.length === 0) {
        return <Placeholder title="No schedules yet">Create a schedule in Planner, then confirm it before simulating.</Placeholder>;
    }

    if (confirmedSchedules.length === 0) {
        return (
            <Placeholder title="No confirmed schedules to simulate">
                Confirm a draft in Schedules before starting its simulation. Draft schedules are still editable plans.
            </Placeholder>
        );
    }

    const scheduleBar = (
        <ScheduleBar
            schedules={scheduleOptions}
            selectedId={selectedId}
            onSelect={setUserChoiceId}
            timelineSummary={timeline
                ? { jobs: timeline.jobs.length, machines: timeline.machines.length, operations: timeline.operations.length }
                : null}
        />
    );

    if (!activeSchedule) {
        return (
            <ManagerShell>
                {scheduleBar}
                <main className="flex flex-1 items-center justify-center p-5">
                    <div className="w-full max-w-prose">
                        {timelineQuery.error ? (
                            <Note intent="danger" role="alert">
                                <div>
                                    <strong>That schedule could not be resolved.</strong>
                                    <p className="mt-1">{errorMessage(timelineQuery.error)}</p>
                                </div>
                            </Note>
                        ) : (
                            <div className="rounded-lg border border-dashed bg-overlay p-8 text-center">
                                <h2 className="font-semibold text-lg">Resolving the schedule…</h2>
                                <p className="mt-2 text-muted-fg text-sm">Loading the confirmed plan from the backend.</p>
                            </div>
                        )}
                    </div>
                </main>
            </ManagerShell>
        );
    }

    const activeMachines = plan?.machines ?? [];
    const activeJobs = plan?.jobs ?? [];
    const completedOps = started ? activeSchedule.ops.filter((op) => op.endMins <= simMins).length : 0;
    const runningOps = started
        ? activeSchedule.ops.filter((op) => op.startMins < simMins && op.endMins > simMins).length
        : 0;
    const usedMachines = activeMachines.filter((machine) =>
        activeSchedule.ops.some((op) => op.machineId === machine.id),
    );
    const backlog = jobsQuery.data ?? null;
    const colors = buildJobColors(backlog ?? plan?.jobs ?? []);
    const jobLabel = (jobId: string) => plan?.jobs.find((job) => job.id === jobId)?.name ?? jobId;
    const statusText = !started ? "Not started" : atEnd ? "Completed" : running ? "Running" : "Paused";

    return (
        <ManagerShell actions={<div className="flex flex-nowrap items-center gap-2.5 whitespace-nowrap shrink-0">
            <Button
                size="sq-sm"
                isDisabled={controlsPending || simulationQuery.isPending}
                onPress={() => void togglePlayback()}
                aria-label={running ? "Pause simulation" : "Play simulation"}
            >
                {running ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <Button intent="outline" size="sm" isDisabled={simulation === null || controlsPending} onPress={() => void resetPlayback()}>
                Reset
            </Button>
            <ToggleGroup
                aria-label="Playback speed"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={new Set([String(speed)])}
                isDisabled={controlsPending}
                onSelectionChange={(keys) => {
                    const [first] = Array.from(keys);
                    if (typeof first === "string") void changeSpeed(Number(first));
                }}
            >
                {SPEEDS.map((option) => (
                    <ToggleGroupItem key={option.value} id={String(option.value)} aria-label={`${option.label} speed: ${option.hint}`}>
                        {option.label}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            <span className="hidden font-semibold tabular-nums whitespace-nowrap sm:inline">{formatOffset(simMins)}</span>
        </div>}>
            {scheduleBar}

            {simulationQuery.error && (
                <Note intent="danger" role="alert" className="mx-5 mt-5">
                    <div>
                        <strong>Could not recover the simulation state.</strong>
                        <p className="mt-1">{errorMessage(simulationQuery.error)}</p>
                    </div>
                </Note>
            )}

            <div className="flex items-center gap-4 border-b bg-navbar px-7 py-2.5">
                <ProgressBar aria-label="Elapsed share of the simulation" className="flex-1" value={makespan === 0 ? 0 : (simMins / makespan) * 100}>
                    <ProgressBarTrack />
                </ProgressBar>
                <span className="shrink-0 text-muted-fg text-sm tabular-nums">{formatDuration(makespan)}</span>
            </div>

            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(240px,0.8fr)_minmax(0,2.4fr)_minmax(220px,0.7fr)]">
                <Card>
                    <CardHeader><CardTitle>Machines now</CardTitle></CardHeader>
                    <CardContent>
                        <ul className="space-y-2.5">
                            {usedMachines.map((machine) => {
                                const activity = machineActivity(activeSchedule, machine.id, simMins);
                                const label = !started ? "Not started" : activity.kind === "running" ? "Running" : activity.kind === "idle" ? "Idle" : "Done";
                                return (
                                    <li
                                        key={machine.id}
                                        className={`rounded-lg border p-3 transition-colors ${hoveredMachineId === machine.id ? "border-primary/40 bg-primary/15" : "border-border bg-muted"}`}
                                        onMouseEnter={() => setHoveredMachineId(machine.id)}
                                        onMouseLeave={() => setHoveredMachineId((previous) => previous === machine.id ? null : previous)}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="font-semibold text-sm">{machine.name}</span>
                                            <Badge intent={started ? ACTIVITY_INTENT[activity.kind] : "secondary"}>{label}</Badge>
                                        </div>
                                        {started && activity.kind === "running" && <>
                                            <div className="mt-2 flex items-center gap-1.5 text-xs"><JobDot colors={colors} jobId={activity.jobId} size="sm" /><strong>{jobLabel(activity.jobId)}</strong> · Op {activity.opIndex}/{activity.opTotal} {activity.opName}</div>
                                            <ProgressBar aria-label={`${machine.name} current operation progress`} value={activity.progressPct} className="mt-2"><ProgressBarTrack className="min-w-0" /></ProgressBar>
                                            <div className="mt-1.5 text-muted-fg text-xs">finishes {formatOffset(activity.endMins)}</div>
                                        </>}
                                        {started && activity.kind === "idle" && <div className="mt-1.5 text-muted-fg text-xs">next job at {formatOffset(activity.nextStartMins ?? 0)}</div>}
                                        {started && activity.kind === "finished" && <div className="mt-1.5 text-muted-fg text-xs">all work complete</div>}
                                    </li>
                                );
                            })}
                        </ul>
                    </CardContent>
                </Card>

                <Card className="min-w-0">
                    <CardHeader className="gap-3">
                        <div className="flex items-center justify-between gap-3"><CardTitle>Schedule playback</CardTitle><Badge intent={atEnd ? "success" : running ? "info" : "secondary"}>{statusText}</Badge></div>
                        <div className="flex flex-wrap items-center gap-4">
                            <div className="flex flex-wrap items-center gap-3 text-muted-fg text-xs">
                                <span>{completedOps} done</span><span>{runningOps} running</span><span>{activeSchedule.ops.length - completedOps - runningOps} to go</span>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <GanttChart
                            machines={activeMachines}
                            jobs={activeJobs}
                            schedule={activeSchedule}
                            colors={colors}
                            mode="simulation"
                            nowMins={started ? simMins : null}
                            selectedJobId={highlightedJobId}
                            highlightedMachineId={hoveredMachineId}
                            zoom={timelineZoom}
                            onSelectJob={(jobId) => setHighlightedJobId((previous) => previous === jobId ? null : jobId)}
                        />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader><CardTitle>Job progress</CardTitle></CardHeader>
                    <CardContent>
                        <Table aria-label="Job progress" selectionMode="single" selectionBehavior="replace" selectedKeys={highlightedJobId ? new Set([highlightedJobId]) : new Set()} onSelectionChange={(keys) => {
                            if (keys === "all") return;
                            const [first] = Array.from(keys);
                            setHighlightedJobId(typeof first === "string" ? first : null);
                        }}>
                            <TableHeader><TableColumn isRowHeader>Job</TableColumn><TableColumn>Ops</TableColumn><TableColumn>State</TableColumn></TableHeader>
                            <TableBody items={activeSchedule.order.map((id) => ({ id }))}>
                                {({ id }) => {
                                    const jobOps = activeSchedule.ops.filter((op) => op.jobId === id);
                                    const done = started ? jobOps.filter((op) => op.endMins <= simMins).length : 0;
                                    const finish = activeSchedule.jobFinish[id] ?? 0;
                                    const start = activeSchedule.jobStart[id] ?? 0;
                                    const state = !started || simMins < start ? "Waiting" : simMins >= finish ? "Done" : "Running";
                                    return <TableRow id={id}><TableCell><span className="flex items-center gap-1.5"><JobDot colors={colors} jobId={id} size="sm" />{jobLabel(id)}</span></TableCell><TableCell className="tabular-nums">{done}/{jobOps.length}</TableCell><TableCell><Badge intent={STATE_INTENT[state]}>{state}</Badge></TableCell></TableRow>;
                                }}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            </main>
        </ManagerShell>
    );
}
