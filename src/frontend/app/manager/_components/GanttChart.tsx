"use client";

import { Button } from "react-aria-components/Button";
import { ToggleButton } from "react-aria-components/ToggleButton";
import { jobColor, tint, type JobColor } from "../_lib/colors";
import { formatDuration, formatOffset } from "../_lib/scheduling";
import type { GeneratedSchedule, JobDef, Machine } from "../_lib/types";

/**
 * The schedule grid, shared by the plan view and the simulation.
 *
 * In `plan` mode it draws the generated schedule as-is: every block is the
 * colour of its job, so a job can be traced across machines. In `simulation`
 * mode the same geometry is re-shaded by where `nowMins` falls, and a "now"
 * line is drawn — so the two views are visibly different reads of one plan
 * rather than two versions of the same picture.
 *
 * Geometry comes from two CSS custom properties, `--gutter` and `--hour`, and
 * every offset is `calc()`-ed from them. Nothing is a percentage, so the hour
 * ruler and the blocks underneath it cannot drift apart.
 *
 * Intent UI ships no timeline or Gantt component, so this stays bespoke — but
 * it is built on the same React Aria primitives Intent UI wraps, and paints
 * itself from the same theme tokens, so it belongs to the same system.
 */

type OperationState = "plan" | "done" | "running" | "upcoming";

function operationState(startMins: number, endMins: number, nowMins: number | null): OperationState {
    if (nowMins === null) return "plan";
    if (endMins <= nowMins) return "done";
    if (startMins <= nowMins) return "running";
    return "upcoming";
}

function blockStyle(color: JobColor, state: OperationState): React.CSSProperties {
    switch (state) {
        case "done":
            return { background: tint(color.fill, 0.34), color: "#0b0b0b", borderColor: tint(color.fill, 0.62) };
        case "upcoming":
            return { background: tint(color.fill, 0.14), color: "#334155", borderColor: tint(color.fill, 0.45) };
        default: // "plan" and "running" both show the job at full strength
            return { background: color.fill, color: color.ink, borderColor: color.fill };
    }
}

const STATE_MARK: Record<OperationState, string> = {
    plan: "",
    done: "✓ ",
    running: "▶ ",
    upcoming: "",
};

export function GanttChart({
    machines,
    jobs,
    schedule,
    colors,
    mode,
    nowMins = null,
    selectedJobId = null,
    onSelectJob,
}: {
    machines: Machine[];
    jobs: JobDef[];
    schedule: GeneratedSchedule;
    colors: Map<string, JobColor>;
    mode: "plan" | "simulation";
    nowMins?: number | null;
    selectedJobId?: string | null;
    onSelectJob?: (jobId: string) => void;
}) {
    const now = mode === "simulation" ? nowMins : null;
    const hours = Math.max(1, Math.ceil(schedule.makespanMins / 60));
    const jobName = (jobId: string) => jobs.find((job) => job.id === jobId)?.name ?? jobId;

    // Only machines that actually carry work; an empty row is noise.
    const usedMachines = machines.filter((machine) =>
        schedule.ops.some((op) => op.machineId === machine.id),
    );
    const scheduledJobIds = schedule.order;

    return (
        <div className="flex min-h-0 flex-col [--gutter:168px] [--hour:124px]">
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted">
                <div
                    className="relative flex flex-col"
                    style={{ width: `calc(var(--gutter) + var(--hour) * ${hours})` }}
                >
                    <div className="sticky top-0 z-3 flex border-b bg-overlay">
                        <div className="w-(--gutter) shrink-0 border-e px-2.5 py-2 font-bold text-[0.68rem] text-muted-fg uppercase tracking-[0.05em]">
                            Elapsed →
                        </div>
                        {Array.from({ length: hours }, (_, hour) => (
                            <div
                                key={hour}
                                className="w-(--hour) shrink-0 border-s py-2 ps-1.5 font-semibold text-muted-fg text-xs tabular-nums"
                            >
                                {hour === 0 ? "T+0h" : `${hour}h`}
                            </div>
                        ))}
                    </div>

                    {usedMachines.map((machine) => (
                        <div key={machine.id} className="flex border-b bg-overlay last-of-type:border-b-0">
                            <div className="sticky start-0 z-2 w-(--gutter) shrink-0 border-e bg-muted p-2.5">
                                <div className="font-bold text-fg text-sm">{machine.name}</div>
                                <div className="text-muted-fg text-xs">{machine.operator}</div>
                            </div>
                            <div className="relative h-13 flex-1 bg-[repeating-linear-gradient(to_right,var(--color-border)_0,var(--color-border)_1px,transparent_1px,transparent_var(--hour))]">
                                {schedule.ops
                                    .filter((op) => op.machineId === machine.id)
                                    .map((op) => {
                                        const color = jobColor(colors, op.jobId);
                                        const state = operationState(op.startMins, op.endMins, now);
                                        const durationMins = op.endMins - op.startMins;
                                        const dimmed = selectedJobId !== null && selectedJobId !== op.jobId;
                                        // A short block cannot fit both tokens; the job id is the
                                        // one that has to survive, since it carries identity.
                                        const compact = durationMins < 45;
                                        const progressPct =
                                            state === "running" && now !== null
                                                ? ((now - op.startMins) / durationMins) * 100
                                                : 0;

                                        return (
                                            <Button
                                                key={op.opId}
                                                className={`absolute top-1.75 flex h-9.5 min-w-1 cursor-pointer items-center overflow-hidden rounded-sm border px-1.5 text-left font-semibold text-xs outline-hidden hover:brightness-95 focus-visible:z-4 focus-visible:outline-2 focus-visible:outline-fg focus-visible:outline-offset-1 ${
                                                    dimmed ? "opacity-28" : ""
                                                }`}
                                                style={{
                                                    ...blockStyle(color, state),
                                                    left: `calc(var(--hour) * ${op.startMins / 60})`,
                                                    width: `calc(var(--hour) * ${durationMins / 60} - 2px)`,
                                                }}
                                                onPress={() => onSelectJob?.(op.jobId)}
                                                aria-label={`${op.jobId} ${jobName(op.jobId)}, operation ${op.opIndex} of ${op.opTotal}, ${op.opName}, on ${machine.name}, starts ${formatOffset(op.startMins)}, runs ${formatDuration(durationMins)}${state === "plan" ? "" : `, ${state}`}`}
                                            >
                                                <span className="block truncate leading-tight">
                                                    {STATE_MARK[state]}
                                                    {compact
                                                        ? jobName(op.jobId)
                                                        : `${jobName(op.jobId)} · ${op.opName}`}
                                                </span>
                                                {state === "running" && (
                                                    <span
                                                        className="absolute bottom-0 left-0 h-[3px] opacity-85"
                                                        style={{ width: `${progressPct}%`, background: color.ink }}
                                                    />
                                                )}
                                            </Button>
                                        );
                                    })}
                            </div>
                        </div>
                    ))}

                    {now !== null && (
                        <div
                            className="pointer-events-none absolute top-0 bottom-0 z-3 w-0.5 bg-fg"
                            style={{ left: `calc(var(--gutter) + var(--hour) * ${now / 60})` }}
                        >
                            <span className="absolute top-0 left-[-4px] size-0 border-t-[7px] border-t-fg border-x-[5px] border-x-transparent" />
                        </div>
                    )}
                </div>
            </div>

            <ul className="mt-2.5 flex list-none flex-wrap gap-x-2.5 gap-y-1 p-0">
                {scheduledJobIds.map((jobId) => {
                    const color = jobColor(colors, jobId);
                    const dimmed = selectedJobId !== null && selectedJobId !== jobId;
                    return (
                        <li key={jobId}>
                            <ToggleButton
                                isSelected={selectedJobId === jobId}
                                onChange={() => onSelectJob?.(jobId)}
                                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.75 text-muted-fg text-xs outline-hidden hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1 ${
                                    dimmed ? "opacity-40" : ""
                                }`}
                            >
                                <span
                                    className="size-2.5 shrink-0 rounded-xs"
                                    style={{ background: color.fill }}
                                />
                                <span className="font-bold text-fg">{jobId}</span>
                                <span className="text-muted-fg">{jobName(jobId)}</span>
                            </ToggleButton>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
