"use client";

import { ArrowPathIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    ApiError,
    type ScheduleSummary,
    type ScheduleTimeline,
    fetchScheduleTimeline,
    fetchSchedules,
} from "@/app/_lib/api";
import { useAuth } from "@/app/_components/AuthProvider";
import { UserMenu } from "@/app/_components/UserMenu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Note } from "@/components/ui/note";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
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
import { Wordmark } from "../../_components/Logo";
import { GanttChart } from "../_components/GanttChart";
import { SubNav } from "../_components/SubNav";
import { buildJobColors, jobColor } from "../_lib/colors";
import { formatDuration, formatOffset } from "../_lib/scheduling";
import { timelineToPlan } from "../_lib/timeline";
import type { GeneratedSchedule } from "../_lib/types";

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

type LoadState<Value> =
    | { status: "loading" }
    | { status: "ready"; value: Value }
    | { status: "error"; message: string }
    /** Signed in, but this account may not read schedules. */
    | { status: "forbidden" };

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

const SCHEDULE_STATUS_INTENT = {
    confirmed: "success",
    draft: "warning",
    discarded: "secondary",
} as const;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "The API could not be reached.";
}

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

/** How a schedule reads in the picker: what made it, how long it runs, when. */
function scheduleLabel(schedule: ScheduleSummary): string {
    const makespan = schedule.makespan === null ? "no makespan" : formatDuration(schedule.makespan);
    return `${schedule.strategy} · ${makespan} · ${formatCreated(schedule.created_at)}`;
}

function ManagerTopbar({ children }: { children?: React.ReactNode }) {
    return (
        <header className="flex flex-wrap items-center gap-5 border-b bg-navbar px-7 py-3.5">
            <div className="flex items-center gap-2.5">
                <Wordmark />
                <span className="border-l pl-2.5 font-bold text-muted-fg text-xs uppercase tracking-[0.06em]">
                    Manager
                </span>
            </div>
            <SubNav />
            {children}
            <div className="flex-1" />
            <UserMenu />
        </header>
    );
}

/** Which stored schedule is being simulated, and what it is. */
function ScheduleBar({
    schedules,
    selectedId,
    onSelect,
    selected,
    timeline,
}: {
    schedules: ScheduleSummary[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    selected: ScheduleSummary | null;
    timeline: ScheduleTimeline | null;
}) {
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-navbar px-7 py-2.5">
            <Select
                aria-label="Which schedule to simulate"
                className="min-w-[22rem]"
                selectedKey={selectedId}
                onSelectionChange={(key) => {
                    if (typeof key === "string") onSelect(key);
                }}
            >
                <Label className="sr-only">Schedule</Label>
                <SelectTrigger />
                <SelectContent items={schedules}>
                    {(schedule: ScheduleSummary) => (
                        <SelectItem id={schedule.id} textValue={scheduleLabel(schedule)}>
                            {scheduleLabel(schedule)}
                        </SelectItem>
                    )}
                </SelectContent>
            </Select>

            {selected && (
                <Badge intent={SCHEDULE_STATUS_INTENT[selected.status]}>{selected.status}</Badge>
            )}

            {timeline && (
                <span className="text-muted-fg text-xs">
                    {timeline.jobs.length} jobs × {timeline.machines.length} machines,{" "}
                    {timeline.operations.length} operations — resolved by the API from the stored
                    schedule.
                </span>
            )}
        </div>
    );
}

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
                                    <Button
                                        intent="outline"
                                        size="sm"
                                        className="mt-3"
                                        onPress={onRetry}
                                    >
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

export default function SimulationPage() {
    const [simMins, setSimMins] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(10);
    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);

    const { token, user } = useAuth();
    const [schedules, setSchedules] = useState<LoadState<ScheduleSummary[]>>({ status: "loading" });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);

    // Keyed by the schedule it describes, so "still loading" is derived from a
    // stale key rather than assigned when the selection changes. That keeps the
    // effects below free of synchronous state updates, which cascade renders.
    const [loaded, setLoaded] = useState<{
        id: string;
        state: LoadState<ScheduleTimeline>;
    } | null>(null);

    const timeline = useMemo<LoadState<ScheduleTimeline>>(
        () =>
            selectedId !== null && loaded?.id === selectedId
                ? loaded.state
                : { status: "loading" },
        [selectedId, loaded],
    );

    // The route is manager-only, so a 403 here means the signed-in account is an
    // operator rather than that anything is broken. That reads differently and
    // is reported differently. A 401 is left alone: AuthProvider owns expiry and
    // will drop the token and bounce to the login screen on its own.
    useEffect(() => {
        if (token === null) return;
        let current = true;
        fetchSchedules(token)
            .then((value) => {
                if (!current) return;
                setSchedules({ status: "ready", value });
                // Prefer a confirmed schedule: it is the only kind simulation
                // accepts, so opening on a draft would only show an error.
                const confirmed = value.find((schedule) => schedule.status === "confirmed");
                setSelectedId((existing) => existing ?? confirmed?.id ?? value[0]?.id ?? null);
            })
            .catch((error: unknown) => {
                if (!current) return;
                if (error instanceof ApiError && error.isForbidden) {
                    setSchedules({ status: "forbidden" });
                    return;
                }
                setSchedules({ status: "error", message: errorMessage(error) });
            });
        return () => {
            current = false;
        };
    }, [attempt, token]);

    const retrySchedules = useCallback(() => {
        setSchedules({ status: "loading" });
        setAttempt((count) => count + 1);
    }, []);

    // Refetched whenever the selection changes. A timeline is immutable for a
    // given schedule, so this is the only time it is asked for.
    useEffect(() => {
        if (selectedId === null || token === null) return;
        let current = true;
        fetchScheduleTimeline(selectedId, token)
            .then((value) => {
                if (current) setLoaded({ id: selectedId, state: { status: "ready", value } });
            })
            .catch((error: unknown) => {
                if (current) {
                    setLoaded({
                        id: selectedId,
                        state: { status: "error", message: errorMessage(error) },
                    });
                }
            });
        return () => {
            current = false;
        };
    }, [selectedId, token]);

    const plan = useMemo(
        () => (timeline.status === "ready" ? timelineToPlan(timeline.value) : null),
        [timeline],
    );

    const activeSchedule = plan?.schedule ?? null;
    const [playingPlan, setPlayingPlan] = useState(activeSchedule);

    const colors = useMemo(() => buildJobColors(plan?.jobs ?? []), [plan]);
    const makespan = activeSchedule?.makespanMins ?? 0;
    const atEnd = activeSchedule !== null && simMins >= makespan;
    /** Latched "play" only actually advances the clock while there is schedule left. */
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

    if (schedules.status === "loading") {
        return (
            <Placeholder title="Signing in and loading schedules…">
                Reading <code>GET /api/v1/schedules</code>.
            </Placeholder>
        );
    }

    if (schedules.status === "forbidden") {
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

    if (schedules.status === "error") {
        return (
            <Placeholder title="Could not load schedules." danger onRetry={retrySchedules}>
                <p>{schedules.message}</p>
                <p className="mt-1 text-muted-fg">
                    The API answered, but not with a schedule list. Check it is running and that
                    the database has been migrated.
                </p>
            </Placeholder>
        );
    }

    if (schedules.value.length === 0) {
        return (
            <Placeholder title="No schedules in the database">
                Nothing has been scheduled yet. Seed one with{" "}
                <code>make db-seed instance=abz5</code>, then reload.
            </Placeholder>
        );
    }

    const selected = schedules.value.find((schedule) => schedule.id === selectedId) ?? null;
    const scheduleBar = (
        <ScheduleBar
            schedules={schedules.value}
            selectedId={selectedId}
            onSelect={setSelectedId}
            selected={selected}
            timeline={timeline.status === "ready" ? timeline.value : null}
        />
    );

    if (!activeSchedule) {
        return (
            <div className="flex min-h-dvh flex-col bg-bg text-fg">
                <ManagerTopbar />
                {scheduleBar}
                <main className="flex flex-1 items-center justify-center p-5">
                    <div className="w-full max-w-prose">
                        {timeline.status === "error" ? (
                            <Note intent="danger" role="alert">
                                <div>
                                    <strong>That schedule could not be resolved.</strong>
                                    <p className="mt-1">{timeline.message}</p>
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
            </div>
        );
    }

    const activeMachines = plan?.machines ?? [];
    const activeJobs = plan?.jobs ?? [];
    const completedOps = activeSchedule.ops.filter((op) => op.endMins <= simMins).length;
    const runningOps = activeSchedule.ops.filter(
        (op) => op.startMins <= simMins && op.endMins > simMins,
    ).length;
    const overallPct = makespan === 0 ? 0 : Math.round((simMins / makespan) * 100);
    const usedMachines = activeMachines.filter((machine) =>
        activeSchedule.ops.some((op) => op.machineId === machine.id),
    );

    return (
        <div className="flex min-h-dvh flex-col bg-bg text-fg">
            <ManagerTopbar>
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
            </ManagerTopbar>

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

            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(240px,0.8fr)_2.4fr_minmax(220px,0.7fr)]">
                <Card>
                    <CardHeader>
                        <CardTitle>Machines now</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <ul className="space-y-2.5">
                            {usedMachines.map((machine) => {
                                const activity = machineActivity(activeSchedule, machine.id, simMins);
                                return (
                                    <li key={machine.id} className="rounded-lg border bg-muted p-3">
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
                                                    <span
                                                        className="size-2.5 shrink-0 rounded-full"
                                                        style={{ background: jobColor(colors, activity.jobId).fill }}
                                                    />
                                                    <strong>{activity.jobId}</strong> · Op {activity.opIndex}/
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

                <Card>
                    <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
                        <CardTitle>Schedule playback</CardTitle>
                        <div className="flex flex-wrap items-center gap-3 text-muted-fg text-xs">
                            <span className="flex items-center gap-1.5">
                                <span className="size-2.5 rounded-xs bg-fg/25" />✓ Completed
                            </span>
                            <span className="flex items-center gap-1.5">
                                <span className="size-2.5 rounded-xs bg-primary" />▶ Running
                            </span>
                            <span className="flex items-center gap-1.5">
                                <span className="size-2.5 rounded-xs bg-fg/10" />Upcoming
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
                                                    <span
                                                        className="size-2.5 shrink-0 rounded-full"
                                                        style={{ background: jobColor(colors, id).fill }}
                                                    />
                                                    {id}
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
        </div>
    );
}
