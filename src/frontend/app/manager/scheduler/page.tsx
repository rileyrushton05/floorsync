"use client";

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
import { ExclamationCircleIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { priorityIntent } from "../../_lib/badge-intent";
import { GanttChart } from "../_components/GanttChart";
import { ManagerTopbar } from "../_components/ManagerTopbar";
import { usePlanning } from "../_components/PlanningProvider";
import { buildJobColors, jobColor } from "../_lib/colors";
import { formatDuration, formatOffset, totalWorkMins, validateSelection } from "../_lib/scheduling";

/**
 * Schedule builder.
 *
 * This page answers "what would the plan look like if we released these jobs?"
 * It is deliberately free of playback controls and wall-clock dates — the
 * output is a plan measured from T+0. Watching that plan run over time is the
 * simulation's job, on its own route.
 */
export default function SchedulerPage() {
    const {
        machines, jobs, selectedJobIds, setSelectedJobIds,
        schedule, scheduleErrors, scheduleStale, generate, clearSchedule,
    } = usePlanning();

    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);

    const colors = useMemo(() => buildJobColors(jobs), [jobs]);
    const machineName = (id: string) => machines.find((machine) => machine.id === id)?.name ?? id;

    // Shown inline as the manager ticks boxes, so unsatisfiable selections are
    // visible before they press Generate rather than after.
    const selectionProblems = useMemo(
        () => validateSelection(jobs, machines, selectedJobIds),
        [jobs, machines, selectedJobIds],
    );

    const selectedWorkMins = jobs
        .filter((job) => selectedJobIds.includes(job.id))
        .reduce((total, job) => total + totalWorkMins(job), 0);

    function toggleHighlight(jobId: string) {
        setHighlightedJobId((previous) => (previous === jobId ? null : jobId));
    }

    return (
        <div className="flex min-h-dvh flex-col bg-bg text-fg">
            <ManagerTopbar>
                {schedule && (
                    <Button intent="plain" onPress={clearSchedule}>
                        Clear plan
                    </Button>
                )}
                <Button onPress={generate}>
                    {schedule ? "Regenerate schedule" : "Generate schedule"}
                </Button>
            </ManagerTopbar>

            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(260px,0.8fr)_2.2fr_minmax(260px,0.9fr)]">
                {/* ===== SELECTION ===== */}
                <Card>
                    <CardHeader className="flex-row items-center gap-2.5">
                        <CardTitle>Release to schedule</CardTitle>
                        <Badge intent="secondary">
                            {selectedJobIds.length} / {jobs.length}
                        </Badge>
                    </CardHeader>
                    <CardContent>
                        <p className="text-muted-fg text-sm">
                            Tick the jobs to include, then generate. The plan is built from their operations,
                            machines and dependencies — not from a calendar.
                        </p>

                        <div className="mt-3 flex items-center gap-3">
                            <Button
                                intent="plain"
                                size="xs"
                                className="px-0 text-primary"
                                onPress={() => setSelectedJobIds(jobs.map((job) => job.id))}
                            >
                                Select all
                            </Button>
                            <Button
                                intent="plain"
                                size="xs"
                                className="px-0 text-primary"
                                onPress={() => setSelectedJobIds([])}
                            >
                                Clear
                            </Button>
                        </div>

                        <CheckboxGroup
                            aria-label="Jobs to release"
                            value={selectedJobIds}
                            onChange={setSelectedJobIds}
                            className="mt-3"
                        >
                            {jobs.map((job) => {
                                const checked = selectedJobIds.includes(job.id);
                                const missingDeps = job.dependsOn.filter((depId) => !selectedJobIds.includes(depId));
                                return (
                                    <CheckboxField
                                        key={job.id}
                                        value={job.id}
                                        className="rounded-lg p-2 transition-colors data-[hovered]:bg-muted"
                                    >
                                        <Checkbox>
                                            <span className="flex min-w-0 flex-col gap-0.5">
                                                <span className="flex items-center gap-2">
                                                    <span
                                                        className="size-3 shrink-0 rounded-full"
                                                        style={{ background: jobColor(colors, job.id).fill }}
                                                    />
                                                    <span className="font-semibold text-sm">{job.id}</span>
                                                    <Badge intent={priorityIntent(job.priority)}>{job.priority}</Badge>
                                                </span>
                                                <span className="text-sm">{job.name}</span>
                                                <span className="text-muted-fg text-xs">
                                                    {job.operations.length} ops · {formatDuration(totalWorkMins(job))}
                                                </span>
                                                {job.dependsOn.length > 0 && (
                                                    <span
                                                        className={
                                                            missingDeps.length > 0
                                                                ? "text-danger text-xs"
                                                                : "text-muted-fg text-xs"
                                                        }
                                                    >
                                                        after {job.dependsOn.join(", ")}
                                                        {checked && missingDeps.length > 0 && " — not selected"}
                                                    </span>
                                                )}
                                            </span>
                                        </Checkbox>
                                    </CheckboxField>
                                );
                            })}
                        </CheckboxGroup>

                        {jobs.length === 0 && (
                            <p className="text-muted-fg text-sm">
                                No jobs in the backlog.{" "}
                                <Link href="/manager/jobs" className="text-primary">
                                    Create one →
                                </Link>
                            </p>
                        )}

                        <Separator className="my-3" />
                        <div className="text-muted-fg text-sm">
                            {selectedJobIds.length} selected · {formatDuration(selectedWorkMins)} of machine time
                        </div>
                    </CardContent>
                </Card>

                {/* ===== PLAN ===== */}
                <Card>
                    <CardHeader className="flex-row items-center justify-between gap-3">
                        <CardTitle>Generated plan</CardTitle>
                        {schedule && (
                            <span className="text-muted-fg text-sm">
                                makespan {formatDuration(schedule.makespanMins)} · {schedule.ops.length} operations
                            </span>
                        )}
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {scheduleErrors.length > 0 && (
                            <Note intent="danger" role="alert" indicator={false}>
                                <div className="flex items-center gap-2">
                                    <ExclamationCircleIcon className="size-5" />
                                    <strong>This selection cannot be scheduled</strong>
                                </div>
                                <ul className="mt-1 list-disc ps-5">
                                    {scheduleErrors.map((error) => (
                                        <li key={error}>{error}</li>
                                    ))}
                                </ul>
                            </Note>
                        )}

                        {schedule && scheduleStale && (
                            <Note intent="warning" role="status">
                                Job definitions have changed since this plan was generated. Regenerate to pick up
                                the edits.
                            </Note>
                        )}

                        {schedule ? (
                            <GanttChart
                                machines={machines}
                                jobs={jobs}
                                schedule={schedule}
                                colors={colors}
                                mode="plan"
                                selectedJobId={highlightedJobId}
                                onSelectJob={toggleHighlight}
                            />
                        ) : (
                            <div className="rounded-lg border border-dashed p-8 text-center">
                                <h3 className="font-semibold text-lg">No plan yet</h3>
                                <p className="mx-auto mt-2 max-w-prose text-muted-fg text-sm">
                                    Pick the jobs to release on the left, then press{" "}
                                    <strong className="text-fg">Generate schedule</strong>. Operations are placed on
                                    the earliest free slot on their machine that respects the order within each job
                                    and every dependency between jobs.
                                </p>
                                {selectionProblems.length > 0 && (
                                    <ul className="mx-auto mt-4 w-fit list-disc space-y-1 ps-5 text-left text-danger text-sm">
                                        {selectionProblems.map((problem) => (
                                            <li key={problem}>{problem}</li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* ===== SUMMARY ===== */}
                <Card>
                    <CardHeader>
                        <CardTitle>Plan summary</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {schedule ? (
                            <>
                                <div className="grid grid-cols-2 gap-2.5">
                                    <div className="rounded-lg border bg-muted p-3">
                                        <div className="font-bold text-xl tabular-nums">
                                            {formatDuration(schedule.makespanMins)}
                                        </div>
                                        <div className="text-muted-fg text-xs">Makespan</div>
                                    </div>
                                    <div className="rounded-lg border bg-muted p-3">
                                        <div className="font-bold text-xl tabular-nums">{schedule.order.length}</div>
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

                                {/* The table view: every job's placement in text, so the plan is
                                    readable without relying on the colour channel. */}
                                <h3 className="mt-5 font-semibold text-sm">Placement order</h3>
                                <p className="mt-1 text-muted-fg text-xs">
                                    Dependencies first, then priority. Click a row to trace it on the grid.
                                </p>
                                <Table
                                    aria-label="Placement order"
                                    selectionMode="single"
                                    selectionBehavior="replace"
                                    selectedKeys={highlightedJobId ? new Set([highlightedJobId]) : new Set()}
                                    onSelectionChange={(keys) => {
                                        if (keys === "all") return;
                                        const [first] = Array.from(keys);
                                        if (typeof first === "string") toggleHighlight(first);
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
                                        {({ id, index }) => {
                                            const job = jobs.find((candidate) => candidate.id === id);
                                            return (
                                                <TableRow id={id}>
                                                    <TableCell className="tabular-nums">{index + 1}</TableCell>
                                                    <TableCell>
                                                        <span className="flex items-center gap-2">
                                                            <span
                                                                className="size-3 shrink-0 rounded-full"
                                                                style={{ background: jobColor(colors, id).fill }}
                                                            />
                                                            <span>
                                                                <strong>{id}</strong>
                                                                <br />
                                                                <span className="text-muted-fg text-xs">{job?.name}</span>
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
                                            );
                                        }}
                                    </TableBody>
                                </Table>

                                <Separator className="my-3" />
                                <Link href="/manager/simulation" className="text-primary text-sm">
                                    Run this plan in the simulation →
                                </Link>
                            </>
                        ) : (
                            <p className="text-muted-fg text-sm">
                                Generate a schedule to see its makespan, machine load and placement order.
                            </p>
                        )}
                    </CardContent>
                </Card>
            </main>
        </div>
    );
}
