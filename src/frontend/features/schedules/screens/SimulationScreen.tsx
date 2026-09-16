"use client";

import { useAuth } from "@/core/auth/AuthProvider";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { useJobSummaries } from "@/features/jobs/data/queries";
import { toScheduleOption } from "@/features/schedules/model/schedule";
import { useScheduleSummaries, useScheduleTimeline } from "@/features/schedules/data/queries";
import { ScheduleBar } from "@/features/schedules/ui/ScheduleBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Note } from "@/components/ui/note";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { Slider, SliderFill, SliderThumb, SliderTrack } from "@/components/ui/slider";
import {
    Table,
    TableBody,
    TableCell,
    TableColumn,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ArrowPathIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GanttChart } from "@/domains/scheduling/ui/GanttChart";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { buildJobColors } from "@/domains/scheduling/colors";
import { JobDot } from "@/domains/scheduling/ui/JobDot";
import { formatDuration, formatOffset } from "@/domains/scheduling/format";
import { timelineToPlan } from "@/domains/scheduling/timeline";
import type { GeneratedSchedule } from "@/domains/scheduling/types";

/**
 * Simulation.
 *
 * Runs a clock across a schedule held in the database. Nothing here changes the
 * schedule — this view answers "what does the shop look like N minutes in?",
 * where the scheduler answers "what is the plan?".
 *
 * Everything on screen comes from two API reads: `GET /schedules` to choose
 * between the schedules that exist, then `GET /schedules/{id}/timeline` for the
 * one picked. Every start and end time was computed by the backend's resolver;
 * this page places bars and moves a clock across them.
 *
 * Playback is local. A confirmed schedule's timeline is immutable, so the clock
 * animates against a payload fetched once rather than polling for a position.
 *
 * Speed is expressed as shop-minutes per real second, so 60x means one hour of
 * the schedule passes every second.
 */

const SPEEDS = [
    { value: 1, label: "1×", hint: "1 min/s" },
    { value: 10, label: "10×", hint: "10 min/s" },
    { value: 60, label: "60×", hint: "1 hr/s" },
];

const TICK_MS = 100;

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

/** A full-page state for when there is nothing to draw yet. */
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
    const [simMins, setSimMins] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(10);
    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);

    const { user } = useAuth();
    const schedulesQuery = useScheduleSummaries();
    const [selectedOverrideId, setSelectedOverrideId] = useState<string | null>(null);
    const schedules = useMemo(() => schedulesQuery.data ?? [], [schedulesQuery.data]);
    const defaultScheduleId = schedules.find((schedule) => schedule.status === "confirmed")?.id ?? schedules[0]?.id ?? null;
    const selectedId = schedules.some((schedule) => schedule.id === selectedOverrideId)
        ? selectedOverrideId
        : defaultScheduleId;
    const jobsQuery = useJobSummaries();
    const timelineQuery = useScheduleTimeline(selectedId);
    const timeline = timelineQuery.data ?? null;
    const plan = useMemo(() => (timeline ? timelineToPlan(timeline) : null), [timeline]);
    const scheduleOptions = useMemo(() => schedules.map(toScheduleOption), [schedules]);

    const activeSchedule = plan?.schedule ?? null;
    const [playingPlan, setPlayingPlan] = useState(activeSchedule);

    // Colour is keyed off the backlog, exactly as the scheduler screen keys it,
    // so a job wears the same colour here as it does on the plan it came from
    // and in the job builder. A timeline lane carries no creation time, so
    // building from `plan.jobs` would order by the backend's lane order instead
    // and hand the same job two different colours on two screens. The plan's own
    // jobs stay the fallback for when the backlog could not be read.
    const backlog = jobsQuery.data ?? null;
    const colors = useMemo(() => buildJobColors(backlog ?? plan?.jobs ?? []), [backlog, plan]);
    const jobLabel = useCallback(
        (jobId: string) => plan?.jobs.find((job) => job.id === jobId)?.name ?? jobId,
        [plan],
    );
    const makespan = activeSchedule?.makespanMins ?? 0;
    const atEnd = activeSchedule !== null && simMins >= makespan;
    /** Latched "play" only actually advances the clock while there is schedule left. */
    // Hovering a machine card tints that machine's row in the plan playback.
    const [hoveredMachineId, setHoveredMachineId] = useState<string | null>(null);

    const running = playing && !atEnd;

    // Switching schedules invalidates the position we were at. Rewinding during
    // render rather than from an effect avoids painting one frame of the new
    // schedule at the old schedule's clock.
    if (activeSchedule !== playingPlan) {
        setPlayingPlan(activeSchedule);
        setSimMins(0);
        setPlaying(false);
        setHighlightedJobId(null);
    }

    // Torn down the moment the clock reaches the makespan, so a finished run
    // costs nothing rather than ticking against a clamped value.
    useEffect(() => {
        if (!running || !activeSchedule) return;
        const id = setInterval(() => {
            setSimMins((previous) =>
                Math.min(previous + speed * (TICK_MS / 1000), activeSchedule.makespanMins),
            );
        }, TICK_MS);
        return () => clearInterval(id);
    }, [running, speed, activeSchedule]);

    if (schedulesQuery.isPending) {
        return (
            <Placeholder title="Signing in and loading schedules…">
                Reading <code>GET /api/v1/schedules</code>.
            </Placeholder>
        );
    }

    if (schedulesQuery.error instanceof ApiError && schedulesQuery.error.isForbidden) {
        return (
            <Placeholder title="This needs a manager account">
                <p>
                    You are signed in as <strong>{user?.name}</strong> ({user?.role}). Reading
                    schedules is restricted to managers, so there is nothing to simulate here.
                </p>
                <p className="mt-2">Sign out and sign in with a manager account to continue.</p>
            </Placeholder>
        );
    }

    if (schedulesQuery.error) {
        return (
            <Placeholder title="Could not load schedules." danger onRetry={() => void schedulesQuery.refetch()}>
                <p>{errorMessage(schedulesQuery.error)}</p>
                <p className="mt-1 text-muted-fg">
                    The API answered, but not with a schedule list. Check it is running and that
                    the database has been migrated.
                </p>
            </Placeholder>
        );
    }

    if (schedules.length === 0) {
        return (
            <Placeholder title="No schedules in the database">
                Nothing has been scheduled yet. Seed one with{" "}
                <code>make db-seed instance=abz5</code>, then reload.
            </Placeholder>
        );
    }

    const scheduleBar = (
        <ScheduleBar
            schedules={scheduleOptions}
            selectedId={selectedId}
            onSelect={setSelectedOverrideId}
            timelineSummary={timeline
                ? {
                      jobs: timeline.jobs.length,
                      machines: timeline.machines.length,
                      operations: timeline.operations.length,
                  }
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
                                    <p className="mt-1 text-muted-fg">
                                        A schedule with no entries has no timeline. Pick another, or
                                        seed one with <code>make db-seed instance=abz5</code>.
                                    </p>
                                </div>
                            </Note>
                        ) : (
                            <div className="rounded-lg border border-dashed bg-overlay p-8 text-center">
                                <h2 className="font-semibold text-lg">Resolving the schedule…</h2>
                                <p className="mt-2 text-muted-fg text-sm">
                                    The backend is placing every operation on the clock from the
                                    schedule&apos;s entries and dependencies.
                                </p>
                            </div>
                        )}
                    </div>
                </main>
            </ManagerShell>
        );
    }

    const activeMachines = plan?.machines ?? [];
    const activeJobs = plan?.jobs ?? [];
    const completedOps = activeSchedule.ops.filter((op) => op.endMins <= simMins).length;
    const runningOps = activeSchedule.ops.filter(
        (op) => op.startMins < simMins && op.endMins > simMins,
    ).length;
    const overallPct = makespan === 0 ? 0 : Math.round((simMins / makespan) * 100);
    const usedMachines = activeMachines.filter((machine) =>
        activeSchedule.ops.some((op) => op.machineId === machine.id),
    );

    return (
        <ManagerShell actions={<>
                <div className="flex flex-wrap items-center gap-2.5">
                    <Button
                        size="sq-sm"
                        onPress={() => {
                            if (atEnd) setSimMins(0);
                            setPlaying((value) => (atEnd ? true : !value));
                        }}
                        aria-label={running ? "Pause simulation" : "Play simulation"}
                    >
                        {running ? <PauseIcon /> : <PlayIcon />}
                    </Button>
                    <Button
                        intent="outline"
                        size="sm"
                        onPress={() => {
                            setPlaying(false);
                            setSimMins(0);
                        }}
                    >
                        Reset
                    </Button>

                    <ToggleGroup
                        aria-label="Playback speed"
                        selectionMode="single"
                        disallowEmptySelection
                        selectedKeys={new Set([String(speed)])}
                        onSelectionChange={(keys) => {
                            const [first] = Array.from(keys);
                            if (typeof first === "string") setSpeed(Number(first));
                        }}
                    >
                        {SPEEDS.map((option) => (
                            <ToggleGroupItem
                                key={option.value}
                                id={String(option.value)}
                                aria-label={`${option.label} speed — ${option.hint}`}
                            >
                                {option.label}
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>

                    <span className="font-semibold tabular-nums">{formatOffset(simMins)}</span>
                </div>
            </>}>

            {scheduleBar}

            <div className="flex items-center gap-4 border-b bg-navbar px-7 py-2.5">
                <Slider
                    aria-label="Scrub the simulation clock"
                    className="flex-1"
                    minValue={0}
                    maxValue={makespan}
                    step={1}
                    value={simMins}
                    onChange={(value) => {
                        setPlaying(false);
                        setSimMins(Array.isArray(value) ? value[0] : value);
                    }}
                >
                    <Label className="sr-only">Scrub</Label>
                    <SliderTrack>
                        <SliderFill />
                        <SliderThumb />
                    </SliderTrack>
                </Slider>
                <span className="shrink-0 text-muted-fg text-sm tabular-nums">
                    {formatDuration(makespan)}
                </span>
            </div>

            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(240px,0.8fr)_minmax(0,2.4fr)_minmax(220px,0.7fr)]">
                <Card>
                    <CardHeader>
                        <CardTitle>Machines now</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <ul className="space-y-2.5">
                            {usedMachines.map((machine) => {
                                const activity = machineActivity(activeSchedule, machine.id, simMins);
                                return (
                                    <li
                                        key={machine.id}
                                        className={`rounded-lg border p-3 transition-colors ${hoveredMachineId === machine.id
                                            ? "border-primary/40 bg-primary/15"
                                            : "border-border bg-muted"
                                            }`}
                                        onMouseEnter={() => setHoveredMachineId(machine.id)}
                                        onMouseLeave={() =>
                                            setHoveredMachineId((previous) =>
                                                previous === machine.id ? null : previous,
                                            )
                                        }
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="font-semibold text-sm">{machine.name}</span>
                                            <Badge intent={ACTIVITY_INTENT[activity.kind]}>
                                                {activity.kind === "running"
                                                    ? "Running"
                                                    : activity.kind === "idle"
                                                        ? "Idle"
                                                        : "Done"}
                                            </Badge>
                                        </div>
                                        <div className="text-muted-fg text-xs">{machine.operator}</div>
                                        {activity.kind === "running" && (
                                            <>
                                                <div className="mt-2 flex items-center gap-1.5 text-xs">
                                                    <JobDot colors={colors} jobId={activity.jobId} size="sm" />
                                                    <strong>{jobLabel(activity.jobId)}</strong> · Op {activity.opIndex}/
                                                    {activity.opTotal} {activity.opName}
                                                </div>
                                                <ProgressBar
                                                    aria-label={`${machine.name} current operation progress`}
                                                    value={activity.progressPct}
                                                    className="mt-2"
                                                >
                                                    <ProgressBarTrack className="min-w-0" />
                                                </ProgressBar>
                                                <div className="mt-1.5 text-muted-fg text-xs">
                                                    finishes {formatOffset(activity.endMins)}
                                                </div>
                                            </>
                                        )}
                                        {activity.kind === "idle" && (
                                            <div className="mt-1.5 text-muted-fg text-xs">
                                                next job at {formatOffset(activity.nextStartMins ?? 0)}
                                            </div>
                                        )}
                                        {activity.kind === "finished" && (
                                            <div className="mt-1.5 text-muted-fg text-xs">all work complete</div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </CardContent>
                </Card>

                <Card className="min-w-0">
                    <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
                        <CardTitle>Schedule playback</CardTitle>
                        <div className="flex flex-wrap items-center gap-3 text-muted-fg text-xs">
                            <span className={`flex items-center gap-1.5 transition-colors ${atEnd ? "font-semibold text-success" : ""}`}>
                                <span className={`size-2.5 rounded-xs transition-colors ${atEnd ? "bg-success" : "bg-fg/25"}`} />✓ Completed
                            </span>
                            <span className={`flex items-center gap-1.5 transition-colors ${runningOps > 0 ? "font-semibold text-primary" : ""
                                }`}>
                                <span className={`size-2.5 rounded-xs transition-colors ${runningOps > 0 ? "bg-primary" : "bg-fg/25"
                                    }`} />▶ Running
                            </span>
                            <span className={`flex items-center gap-1.5 transition-colors ${simMins <= 0 ? "font-semibold text-warning" : ""}`}>
                                <span className={`size-2.5 rounded-xs transition-colors ${simMins <= 0 ? "bg-warning" : "bg-fg/10"}`} />Upcoming
                            </span>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex items-center gap-3">
                            <ProgressBar
                                aria-label="Elapsed share of the schedule"
                                value={overallPct}
                                className="flex-1"
                            >
                                <ProgressBarTrack className="min-w-0" />
                            </ProgressBar>
                            <span className="shrink-0 text-muted-fg text-xs">
                                {completedOps} done · {runningOps} running ·{" "}
                                {activeSchedule.ops.length - completedOps - runningOps} to go
                            </span>
                        </div>

                        <GanttChart
                            machines={activeMachines}
                            jobs={activeJobs}
                            schedule={activeSchedule}
                            colors={colors}
                            mode="simulation"
                            nowMins={simMins}
                            selectedJobId={highlightedJobId}
                            highlightedMachineId={hoveredMachineId}
                            onSelectJob={(jobId) =>
                                setHighlightedJobId((previous) => (previous === jobId ? null : jobId))
                            }
                        />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Job progress</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Table
                            aria-label="Job progress"
                            selectionMode="single"
                            selectionBehavior="replace"
                            selectedKeys={highlightedJobId ? new Set([highlightedJobId]) : new Set()}
                            onSelectionChange={(keys) => {
                                if (keys === "all") return;
                                const [first] = Array.from(keys);
                                if (typeof first === "string") {
                                    setHighlightedJobId((previous) => (previous === first ? null : first));
                                } else {
                                    setHighlightedJobId(null);
                                }
                            }}
                        >
                            <TableHeader>
                                <TableColumn isRowHeader>Job</TableColumn>
                                <TableColumn>Ops</TableColumn>
                                <TableColumn>State</TableColumn>
                            </TableHeader>
                            <TableBody items={activeSchedule.order.map((id) => ({ id }))}>
                                {({ id }) => {
                                    const jobOps = activeSchedule.ops.filter((op) => op.jobId === id);
                                    const done = jobOps.filter((op) => op.endMins <= simMins).length;
                                    const finish = activeSchedule.jobFinish[id] ?? 0;
                                    const start = activeSchedule.jobStart[id] ?? 0;
                                    const state =
                                        simMins >= finish ? "Done" : simMins >= start ? "Running" : "Waiting";
                                    return (
                                        <TableRow id={id}>
                                            <TableCell>
                                                <span className="flex items-center gap-1.5">
                                                    <JobDot colors={colors} jobId={id} size="sm" />
                                                    {jobLabel(id)}
                                                </span>
                                            </TableCell>
                                            <TableCell className="tabular-nums">
                                                {done}/{jobOps.length}
                                            </TableCell>
                                            <TableCell>
                                                <Badge intent={STATE_INTENT[state]}>{state}</Badge>
                                            </TableCell>
                                        </TableRow>
                                    );
                                }}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            </main>
        </ManagerShell>
    );
}
