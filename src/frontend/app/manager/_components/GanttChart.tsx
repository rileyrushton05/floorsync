"use client";

import { jobColor, tint, type JobColor } from "../_lib/colors";
import { formatDuration, formatOffset } from "../_lib/scheduling";
import type { GeneratedSchedule, JobDef, Machine } from "../_lib/types";
import styles from "./GanttChart.module.css";

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
        <div className={styles.wrap}>
            <div className={styles.scroller}>
                <div className={styles.grid} style={{ width: `calc(var(--gutter) + var(--hour) * ${hours})` }}>
                    <div className={styles.rulerRow}>
                        <div className={styles.gutterHead}>Elapsed →</div>
                        {Array.from({ length: hours }, (_, hour) => (
                            <div key={hour} className={styles.tick}>
                                {hour === 0 ? "T+0h" : `${hour}h`}
                            </div>
                        ))}
                    </div>

                    {usedMachines.map((machine) => (
                        <div key={machine.id} className={styles.machineRow}>
                            <div className={styles.gutter}>
                                <div className={styles.machineName}>{machine.name}</div>
                                <div className={styles.operatorName}>{machine.operator}</div>
                            </div>
                            <div className={styles.track}>
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
                                            <button
                                                key={op.opId}
                                                type="button"
                                                className={`${styles.block} ${dimmed ? styles.blockDimmed : ""}`}
                                                style={{
                                                    ...blockStyle(color, state),
                                                    left: `calc(var(--hour) * ${op.startMins / 60})`,
                                                    width: `calc(var(--hour) * ${durationMins / 60} - 2px)`,
                                                }}
                                                onClick={() => onSelectJob?.(op.jobId)}
                                                title={`${op.jobId} · Op ${op.opIndex}/${op.opTotal} ${op.opName} · ${formatOffset(op.startMins)} for ${formatDuration(durationMins)}`}
                                                aria-label={`${op.jobId} ${jobName(op.jobId)}, operation ${op.opIndex} of ${op.opTotal}, ${op.opName}, on ${machine.name}, starts ${formatOffset(op.startMins)}, runs ${formatDuration(durationMins)}${state === "plan" ? "" : `, ${state}`}`}
                                            >
                                                <span className={styles.blockLabel}>
                                                    {STATE_MARK[state]}
                                                    {compact ? op.jobId : `${op.jobId} · ${op.opName}`}
                                                </span>
                                                {state === "running" && (
                                                    <span
                                                        className={styles.blockProgress}
                                                        style={{ width: `${progressPct}%`, background: color.ink }}
                                                    />
                                                )}
                                            </button>
                                        );
                                    })}
                            </div>
                        </div>
                    ))}

                    {now !== null && (
                        <div
                            className={styles.nowLine}
                            style={{ left: `calc(var(--gutter) + var(--hour) * ${now / 60})` }}
                        >
                            <span className={styles.nowFlag} />
                        </div>
                    )}
                </div>
            </div>

            <ul className={styles.legend}>
                {scheduledJobIds.map((jobId) => {
                    const color = jobColor(colors, jobId);
                    const dimmed = selectedJobId !== null && selectedJobId !== jobId;
                    return (
                        <li key={jobId}>
                            <button
                                type="button"
                                className={`${styles.legendItem} ${dimmed ? styles.legendDimmed : ""}`}
                                onClick={() => onSelectJob?.(jobId)}
                                aria-pressed={selectedJobId === jobId}
                            >
                                <span className={styles.legendSwatch} style={{ background: color.fill }} />
                                <span className={styles.legendId}>{jobId}</span>
                                <span className={styles.legendName}>{jobName(jobId)}</span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
