"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Note } from "@/components/ui/note";
import { Label } from "@/components/ui/field";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { UserMenu } from "@/core/auth/UserMenu";
import { useAuth } from "@/core/auth/AuthProvider";
import { PageMessage } from "@/core/feedback/PageMessage";
import { errorMessage } from "@/core/http/errors";
import { useLiveUpdates, type LiveStatus } from "@/core/live-updates/useLiveUpdates";
import { Wordmark } from "@/core/shell/Logo";
import { formatOffset } from "@/domains/scheduling/format";
import { FALLBACK_POLL_MS, useActiveSimulation, useOperatorTimeline } from "@/features/operator/data/queries";
import { buildOperatorQueue, shiftStatus, simulatedMinutes, upcomingSegments } from "@/features/operator/model/operator-queue";
import { CurrentOperation, UpcomingOperations } from "@/features/operator/ui/OperatorOperations";
import { ShiftStatusCard, ShiftStrip } from "@/features/operator/ui/ShiftPlan";
import { useQueryClient } from "@tanstack/react-query";
import { operatorKeys } from "@/features/operator/data/keys";
import { ArrowPathIcon, CheckCircleIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * The operator's view of their own machine: what to work on now, what is next,
 * and one button to say the current operation is done.
 *
 * The queue is read from the live simulation's confirmed schedule and filtered to
 * the account's machine. Changes arrive over the live-update socket; while it is
 * down the screen falls back to polling the same REST read.
 *
 * PROTOTYPE-ONLY: the API has no endpoint for recording an operation as complete,
 * so "Mark complete" is kept in this browser tab alone. Nothing is sent and no one
 * else sees it, and it is lost on reload. Replace `completed` with a mutation when
 * that contract exists.
 */

const LIVE_INTENT = { live: "success", connecting: "warning", offline: "danger" } as const;
const LIVE_TEXT: Record<LiveStatus, string> = {
    live: "Live",
    connecting: "Connecting…",
    offline: "Offline, refreshing every few seconds",
};

const SIMULATION_NOTE = {
    not_started: "The simulation has not started yet. Your queue is ready and times begin when a manager starts it.",
    paused: "The simulation is paused. Times are frozen until a manager resumes it.",
    complete: "The simulation has finished. Anything still open is past its planned time.",
    running: "",
} as const;

export default function OperatorScreen() {
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const [live, setLive] = useState<LiveStatus>("connecting");
    // A working socket needs no polling; anything else does.
    const simulationQuery = useActiveSimulation(live === "live" ? false : FALLBACK_POLL_MS);
    const simulation = simulationQuery.data ?? null;
    const timelineQuery = useOperatorTimeline(simulation?.schedule_id ?? null);

    const refetchSimulation = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: operatorKeys.activeSimulation });
    }, [queryClient]);
    useLiveUpdates(simulation?.id ?? null, refetchSimulation, setLive);

    const [completed, setCompleted] = useState<{ scheduleId: string; keys: ReadonlySet<string> }>({
        scheduleId: "",
        keys: new Set(),
    });
    const scheduleId = simulation?.schedule_id ?? null;
    const completedKeys = useMemo(
        () => (completed.scheduleId === scheduleId ? completed.keys : new Set<string>()),
        [completed, scheduleId],
    );

    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, []);

    const machineId = user?.machine_id ?? null;
    const timeline = timelineQuery.data ?? null;
    const queue = useMemo(
        () => (timeline && machineId ? buildOperatorQueue(timeline, machineId, completedKeys) : null),
        [timeline, machineId, completedKeys],
    );
    const started = simulation !== null && simulation.status !== "not_started";
    const nowMins = simulation && started ? simulatedMinutes(simulation, nowMs) : null;
    const status = queue ? shiftStatus(queue, nowMins) : null;

    function completeCurrent() {
        if (!queue?.current || !simulation) return;
        const keys = new Set(completedKeys);
        keys.add(queue.current.key);
        setCompleted({ scheduleId: simulation.schedule_id, keys });
    }

    return (
        <div className="flex min-h-dvh flex-col bg-secondary/30 text-fg">
            <header className="flex flex-wrap items-center gap-4 border-b bg-navbar px-5 py-3">
                <div className="flex items-center gap-2.5">
                    <Wordmark />
                    <span className="border-l pl-2.5 font-bold text-muted-fg text-xs uppercase tracking-[0.06em]">
                        Operator
                    </span>
                </div>
                {queue?.machineLabel && <Badge intent="outline" className="px-3 py-1.5">{queue.machineLabel}</Badge>}
                <div className="flex-1" />
                {simulation && <Badge intent={LIVE_INTENT[live]}>{LIVE_TEXT[live]}</Badge>}
                {nowMins !== null && (
                    <span className="font-semibold tabular-nums" aria-label="Simulation time">{formatOffset(nowMins)}</span>
                )}
                <UserMenu />
            </header>

            <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-5 sm:py-8">
                <Content
                    machineId={machineId}
                    simulationLoading={simulationQuery.isPending}
                    simulationError={simulationQuery.error}
                    hasSimulation={simulation !== null}
                    timelineLoading={timelineQuery.isPending}
                    timelineError={timelineQuery.error}
                    onRetry={() => {
                        void simulationQuery.refetch();
                        void timelineQuery.refetch();
                    }}
                >
                    {simulation && simulation.status !== "running" && (
                        <Note intent={simulation.status === "paused" ? "warning" : simulation.status === "complete" ? "success" : "default"}>
                            {SIMULATION_NOTE[simulation.status]}
                        </Note>
                    )}
                    {queue && queue.totalCount > 0 && (
                        <ProgressBar
                            aria-label="Operations completed on this machine"
                            value={(queue.completedCount / queue.totalCount) * 100}
                        >
                            <div className="flex justify-between font-medium text-sm">
                                <Label>Your queue</Label>
                                <span className="text-muted-fg tabular-nums">{queue.completedCount} of {queue.totalCount} done</span>
                            </div>
                            <ProgressBarTrack className="min-w-0 [--progress-content-bg:var(--color-success)]" />
                        </ProgressBar>
                    )}
                    {queue?.current && <ShiftStrip segments={queue.segments} nowMins={nowMins} />}
                    {queue && (
                        queue.current ? (
                            <>
                                {status && <ShiftStatusCard status={status} />}
                                <CurrentOperation
                                    operation={queue.current}
                                    nowMins={nowMins}
                                    onComplete={completeCurrent}
                                    heading={status?.kind === "break" && status.planned ? "Up after your break" : undefined}
                                />
                                <UpcomingOperations segments={upcomingSegments(queue)} nowMins={nowMins} />
                            </>
                        ) : (
                            <Note intent="success" className="max-w-lg">
                                <strong>
                                    <CheckCircleIcon className="mr-1 inline size-4" aria-hidden />
                                    {queue.totalCount === 0 ? "Nothing is scheduled for this machine." : "All operations on this machine are complete."}
                                </strong>
                            </Note>
                        )
                    )}
                </Content>
            </main>

            <footer className="border-t bg-navbar px-5 py-3 text-muted-fg text-sm">
                Completion is recorded on this screen only for now; your coordinator is not notified.
            </footer>
        </div>
    );
}

function Content({
    machineId,
    simulationLoading,
    simulationError,
    hasSimulation,
    timelineLoading,
    timelineError,
    onRetry,
    children,
}: {
    machineId: string | null;
    simulationLoading: boolean;
    simulationError: Error | null;
    hasSimulation: boolean;
    timelineLoading: boolean;
    timelineError: Error | null;
    onRetry: () => void;
    children: React.ReactNode;
}) {
    if (machineId === null) {
        return (
            <PageMessage title="No machine assigned">
                This account is not assigned to a machine, so there is no queue to show. Ask a manager to assign one.
            </PageMessage>
        );
    }
    const error = simulationError ?? timelineError;
    if (error) {
        return (
            <PageMessage title="Could not load your operations" tone="danger">
                {errorMessage(error)}
                <Button intent="outline" size="sm" className="mt-3" onPress={onRetry}>
                    <ArrowPathIcon /> Try again
                </Button>
            </PageMessage>
        );
    }
    if (simulationLoading || (hasSimulation && timelineLoading)) {
        return <PageMessage title="Loading your operations">One moment…</PageMessage>;
    }
    if (!hasSimulation) {
        return (
            <PageMessage title="Nothing running yet">
                No simulation has been started. This page updates by itself when a manager starts one.
            </PageMessage>
        );
    }
    return <>{children}</>;
}
