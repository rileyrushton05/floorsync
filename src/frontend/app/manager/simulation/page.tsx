"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Wordmark } from "../../_components/Logo";
import { GanttChart } from "../_components/GanttChart";
import { usePlanning } from "../_components/PlanningProvider";
import { SubNav } from "../_components/SubNav";
import { buildJobColors, jobColor } from "../_lib/colors";
import { formatDuration, formatOffset } from "../_lib/scheduling";
import type { GeneratedSchedule } from "../_lib/types";
import { IconPause, IconPlay, IconUser } from "../icons";
import styles from "./simulation.module.css";

/**
 * Simulation.
 *
 * Takes whatever plan the scheduler last generated and runs a clock across it.
 * Nothing here changes the plan — this view answers "what does the shop look
 * like N minutes in?", where the scheduler answers "what is the plan?".
 *
 * Speed is expressed as shop-minutes per real second, so 60x means one hour of
 * the plan passes every second.
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

export default function SimulationPage() {
    const { machines, jobs, schedule } = usePlanning();
    const [simMins, setSimMins] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(10);
    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);
    const [playingPlan, setPlayingPlan] = useState(schedule);

    const colors = useMemo(() => buildJobColors(jobs), [jobs]);
    const makespan = schedule?.makespanMins ?? 0;
    const atEnd = schedule !== null && simMins >= makespan;
    /** Latched "play" only actually advances the clock while there is plan left. */
    const running = playing && !atEnd;

    // A plan that was cleared or regenerated invalidates the position we were
    // at. Rewinding during render rather than from an effect avoids painting
    // one frame of the new plan at the old plan's clock.
    if (schedule !== playingPlan) {
        setPlayingPlan(schedule);
        setSimMins(0);
        setPlaying(false);
    }

    // Torn down the moment the clock reaches the makespan, so a finished run
    // costs nothing rather than ticking against a clamped value.
    useEffect(() => {
        if (!running || !schedule) return;
        const id = setInterval(() => {
            setSimMins((previous) => Math.min(previous + speed * (TICK_MS / 1000), schedule.makespanMins));
        }, TICK_MS);
        return () => clearInterval(id);
    }, [running, speed, schedule]);

    if (!schedule) {
        return (
            <div className={styles.shell}>
                <header className={styles.topbar}>
                    <div className={styles.brandGroup}>
                        <Wordmark />
                        <span className={styles.viewLabel}>Manager</span>
                    </div>
                    <SubNav />
                    <div className={styles.topbarSpacer} />
                    <div className={styles.userBlock}>
                        <IconUser />
                        <span className={styles.userName}>Manager</span>
                    </div>
                </header>
                <main className={styles.main}>
                    <div className={styles.emptyState}>
                        <h2>Nothing to simulate yet</h2>
                        <p>
                            The simulation replays a generated plan. Build one first — pick the jobs to
                            release and generate a schedule.
                        </p>
                        <Link className={styles.emptyLink} href="/manager/scheduler">Go to the scheduler →</Link>
                    </div>
                </main>
            </div>
        );
    }

    const completedOps = schedule.ops.filter((op) => op.endMins <= simMins).length;
    const runningOps = schedule.ops.filter((op) => op.startMins <= simMins && op.endMins > simMins).length;
    const overallPct = makespan === 0 ? 0 : Math.round((simMins / makespan) * 100);
    const usedMachines = machines.filter((machine) => schedule.ops.some((op) => op.machineId === machine.id));

    return (
        <div className={styles.shell}>
            <header className={styles.topbar}>
                <div className={styles.brandGroup}>
                    <Wordmark />
                    <span className={styles.viewLabel}>Manager</span>
                </div>
                <SubNav />

                <div className={styles.transport}>
                    <button
                        className={styles.playBtn}
                        onClick={() => {
                            if (atEnd) setSimMins(0);
                            setPlaying((value) => (atEnd ? true : !value));
                        }}
                        aria-label={running ? "Pause simulation" : "Play simulation"}
                    >
                        {running ? <IconPause /> : <IconPlay />}
                    </button>
                    <button
                        className={styles.resetBtn}
                        onClick={() => { setPlaying(false); setSimMins(0); }}
                    >Reset</button>

                    <div className={styles.speedPill} role="group" aria-label="Playback speed">
                        {SPEEDS.map((option) => (
                            <button
                                key={option.value}
                                className={`${styles.speedBtn} ${speed === option.value ? styles.speedBtnOn : ""}`}
                                onClick={() => setSpeed(option.value)}
                                aria-pressed={speed === option.value}
                                title={option.hint}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>

                    <span className={styles.clock}>{formatOffset(simMins)}</span>
                </div>

                <div className={styles.topbarSpacer} />
                <div className={styles.userBlock}>
                    <IconUser />
                    <span className={styles.userName}>Manager</span>
                </div>
            </header>

            <div className={styles.scrubBar}>
                <label className={styles.scrubLabel} htmlFor="sim-scrub">Scrub</label>
                <input
                    id="sim-scrub"
                    type="range"
                    className={styles.scrub}
                    min={0}
                    max={makespan}
                    step={1}
                    value={simMins}
                    onChange={(e) => { setPlaying(false); setSimMins(Number(e.target.value)); }}
                />
                <span className={styles.scrubEnd}>{formatDuration(makespan)}</span>
            </div>

            <main className={styles.main}>
                <aside className={styles.machinePanel}>
                    <div className={styles.panelHead}>
                        <h2 className={styles.panelTitle}>Machines now</h2>
                    </div>
                    <ul className={styles.machineList}>
                        {usedMachines.map((machine) => {
                            const activity = machineActivity(schedule, machine.id, simMins);
                            return (
                                <li key={machine.id} className={styles.machineCard}>
                                    <div className={styles.machineHead}>
                                        <span className={styles.machineName}>{machine.name}</span>
                                        <span className={`${styles.pill} ${styles[`pill_${activity.kind}`]}`}>
                                            {activity.kind === "running" ? "Running"
                                                : activity.kind === "idle" ? "Idle" : "Done"}
                                        </span>
                                    </div>
                                    <div className={styles.machineOperator}>{machine.operator}</div>
                                    {activity.kind === "running" && (
                                        <>
                                            <div className={styles.machineJob}>
                                                <span
                                                    className={styles.dot}
                                                    style={{ background: jobColor(colors, activity.jobId).fill }}
                                                />
                                                <strong>{activity.jobId}</strong> · Op {activity.opIndex}/{activity.opTotal} {activity.opName}
                                            </div>
                                            <div
                                                className={styles.miniTrack}
                                                role="progressbar"
                                                aria-valuenow={Math.round(activity.progressPct)}
                                                aria-valuemin={0}
                                                aria-valuemax={100}
                                                aria-label={`${machine.name} current operation progress`}
                                            >
                                                <div className={styles.miniFill} style={{ width: `${activity.progressPct}%` }} />
                                            </div>
                                            <div className={styles.machineSub}>
                                                finishes {formatOffset(activity.endMins)}
                                            </div>
                                        </>
                                    )}
                                    {activity.kind === "idle" && (
                                        <div className={styles.machineSub}>
                                            next job at {formatOffset(activity.nextStartMins ?? 0)}
                                        </div>
                                    )}
                                    {activity.kind === "finished" && (
                                        <div className={styles.machineSub}>all work complete</div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </aside>

                <section className={styles.timelinePanel}>
                    <div className={styles.panelHead}>
                        <h2 className={styles.panelTitle}>Plan playback</h2>
                        <div className={styles.stateLegend}>
                            <span><span className={styles.swatchDone} />✓ Completed</span>
                            <span><span className={styles.swatchRunning} />▶ Running</span>
                            <span><span className={styles.swatchUpcoming} />Upcoming</span>
                        </div>
                    </div>

                    <div className={styles.overallRow}>
                        <div
                            className={styles.overallTrack}
                            role="progressbar"
                            aria-valuenow={overallPct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label="Elapsed share of the plan"
                        >
                            <div className={styles.overallFill} style={{ width: `${overallPct}%` }} />
                        </div>
                        <span className={styles.overallText}>
                            {completedOps} done · {runningOps} running · {schedule.ops.length - completedOps - runningOps} to go
                        </span>
                    </div>

                    <GanttChart
                        machines={machines}
                        jobs={jobs}
                        schedule={schedule}
                        colors={colors}
                        mode="simulation"
                        nowMins={simMins}
                        selectedJobId={highlightedJobId}
                        onSelectJob={(jobId) =>
                            setHighlightedJobId((previous) => (previous === jobId ? null : jobId))
                        }
                    />
                </section>

                <aside className={styles.jobPanel}>
                    <div className={styles.panelHead}>
                        <h2 className={styles.panelTitle}>Job progress</h2>
                    </div>
                    <table className={styles.jobTable}>
                        <thead>
                            <tr>
                                <th>Job</th>
                                <th>Ops</th>
                                <th>State</th>
                            </tr>
                        </thead>
                        <tbody>
                            {schedule.order.map((jobId) => {
                                const jobOps = schedule.ops.filter((op) => op.jobId === jobId);
                                const done = jobOps.filter((op) => op.endMins <= simMins).length;
                                const finish = schedule.jobFinish[jobId] ?? 0;
                                const start = schedule.jobStart[jobId] ?? 0;
                                const state = simMins >= finish ? "Done"
                                    : simMins >= start ? "Running"
                                    : "Waiting";
                                return (
                                    <tr key={jobId} className={highlightedJobId === jobId ? styles.jobRowOn : ""}>
                                        <td>
                                            <button
                                                type="button"
                                                className={styles.jobBtn}
                                                onClick={() =>
                                                    setHighlightedJobId((previous) => (previous === jobId ? null : jobId))
                                                }
                                                aria-pressed={highlightedJobId === jobId}
                                            >
                                                <span
                                                    className={styles.dot}
                                                    style={{ background: jobColor(colors, jobId).fill }}
                                                />
                                                {jobId}
                                            </button>
                                        </td>
                                        <td className={styles.numeric}>{done}/{jobOps.length}</td>
                                        <td>
                                            <span className={`${styles.pill} ${styles[`pill_${state.toLowerCase()}`]}`}>
                                                {state}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </aside>
            </main>
        </div>
    );
}
