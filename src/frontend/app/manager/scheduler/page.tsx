"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, priorityTone } from "../../_components/Badge";
import { Wordmark } from "../../_components/Logo";
import { GanttChart } from "../_components/GanttChart";
import { usePlanning } from "../_components/PlanningProvider";
import { SubNav } from "../_components/SubNav";
import { buildJobColors, jobColor } from "../_lib/colors";
import { formatDuration, formatOffset, totalWorkMins, validateSelection } from "../_lib/scheduling";
import { IconAlertCircle, IconUser } from "../icons";
import styles from "./scheduler.module.css";

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
        machines, jobs, selectedJobIds, setSelectedJobIds, toggleJobSelected,
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
        <div className={styles.shell}>
            <header className={styles.topbar}>
                <div className={styles.brandGroup}>
                    <Wordmark />
                    <span className={styles.viewLabel}>Manager</span>
                </div>
                <SubNav />
                <div className={styles.topbarSpacer} />
                {schedule && (
                    <button className={styles.ghostBtn} onClick={clearSchedule}>Clear plan</button>
                )}
                <button className={styles.generateBtn} onClick={generate}>
                    {schedule ? "Regenerate schedule" : "Generate schedule"}
                </button>
                <div className={styles.userBlock}>
                    <IconUser />
                    <span className={styles.userName}>Manager</span>
                </div>
            </header>

            <main className={styles.main}>
                {/* ===== SELECTION ===== */}
                <aside className={styles.selectPanel}>
                    <div className={styles.panelHead}>
                        <h2 className={styles.panelTitle}>Release to schedule</h2>
                        <span className={styles.countPill}>{selectedJobIds.length} / {jobs.length}</span>
                    </div>
                    <p className={styles.panelHint}>
                        Tick the jobs to include, then generate. The plan is built from their operations,
                        machines and dependencies — not from a calendar.
                    </p>

                    <div className={styles.selectActions}>
                        <button
                            className={styles.linkBtn}
                            onClick={() => setSelectedJobIds(jobs.map((job) => job.id))}
                        >Select all</button>
                        <button className={styles.linkBtn} onClick={() => setSelectedJobIds([])}>Clear</button>
                    </div>

                    <ul className={styles.jobList}>
                        {jobs.map((job) => {
                            const color = jobColor(colors, job.id);
                            const checked = selectedJobIds.includes(job.id);
                            const missingDeps = job.dependsOn.filter((depId) => !selectedJobIds.includes(depId));
                            return (
                                <li key={job.id}>
                                    <label className={`${styles.jobItem} ${checked ? styles.jobItemOn : ""}`}>
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => toggleJobSelected(job.id)}
                                        />
                                        <span className={styles.jobSwatch} style={{ background: color.fill }} />
                                        <span className={styles.jobBody}>
                                            <span className={styles.jobHead}>
                                                <span className={styles.jobId}>{job.id}</span>
                                                <Badge tone={priorityTone(job.priority)}>{job.priority}</Badge>
                                            </span>
                                            <span className={styles.jobName}>{job.name}</span>
                                            <span className={styles.jobMeta}>
                                                {job.operations.length} ops · {formatDuration(totalWorkMins(job))}
                                            </span>
                                            {job.dependsOn.length > 0 && (
                                                <span className={missingDeps.length > 0 ? styles.jobDepsBad : styles.jobDeps}>
                                                    after {job.dependsOn.join(", ")}
                                                    {checked && missingDeps.length > 0 && " — not selected"}
                                                </span>
                                            )}
                                        </span>
                                    </label>
                                </li>
                            );
                        })}
                        {jobs.length === 0 && (
                            <li className={styles.emptyNote}>
                                No jobs in the backlog. <Link href="/manager/jobs">Create one →</Link>
                            </li>
                        )}
                    </ul>

                    <div className={styles.selectSummary}>
                        {selectedJobIds.length} selected · {formatDuration(selectedWorkMins)} of machine time
                    </div>
                </aside>

                {/* ===== PLAN ===== */}
                <section className={styles.planPanel}>
                    <div className={styles.panelHead}>
                        <h2 className={styles.panelTitle}>Generated plan</h2>
                        {schedule && (
                            <span className={styles.planMeta}>
                                makespan {formatDuration(schedule.makespanMins)} · {schedule.ops.length} operations
                            </span>
                        )}
                    </div>

                    {scheduleErrors.length > 0 && (
                        <div className={styles.errorBox} role="alert">
                            <div className={styles.errorHead}>
                                <IconAlertCircle />
                                <strong>This selection cannot be scheduled</strong>
                            </div>
                            <ul>
                                {scheduleErrors.map((error) => <li key={error}>{error}</li>)}
                            </ul>
                        </div>
                    )}

                    {schedule && scheduleStale && (
                        <div className={styles.staleBox} role="status">
                            Job definitions have changed since this plan was generated. Regenerate to pick up
                            the edits.
                        </div>
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
                        <div className={styles.emptyPlan}>
                            <h3>No plan yet</h3>
                            <p>
                                Pick the jobs to release on the left, then press <strong>Generate schedule</strong>.
                                Operations are placed on the earliest free slot on their machine that respects the
                                order within each job and every dependency between jobs.
                            </p>
                            {selectionProblems.length > 0 && (
                                <ul className={styles.emptyProblems}>
                                    {selectionProblems.map((problem) => <li key={problem}>{problem}</li>)}
                                </ul>
                            )}
                        </div>
                    )}
                </section>

                {/* ===== SUMMARY ===== */}
                <aside className={styles.summaryPanel}>
                    <div className={styles.panelHead}>
                        <h2 className={styles.panelTitle}>Plan summary</h2>
                    </div>

                    {schedule ? (
                        <>
                            <div className={styles.statGrid}>
                                <div className={styles.stat}>
                                    <div className={styles.statValue}>{formatDuration(schedule.makespanMins)}</div>
                                    <div className={styles.statLabel}>Makespan</div>
                                </div>
                                <div className={styles.stat}>
                                    <div className={styles.statValue}>{schedule.order.length}</div>
                                    <div className={styles.statLabel}>Jobs</div>
                                </div>
                            </div>

                            <h3 className={styles.sectionTitle}>Machine load</h3>
                            <ul className={styles.loadList}>
                                {schedule.machineLoad
                                    .filter((load) => load.busyMins > 0)
                                    .map((load) => (
                                        <li key={load.machineId} className={styles.loadRow}>
                                            <span className={styles.loadName}>{machineName(load.machineId)}</span>
                                            <span
                                                className={styles.loadTrack}
                                                role="progressbar"
                                                aria-valuenow={load.utilisationPct}
                                                aria-valuemin={0}
                                                aria-valuemax={100}
                                                aria-label={`${machineName(load.machineId)} utilisation`}
                                            >
                                                <span
                                                    className={styles.loadFill}
                                                    style={{ width: `${load.utilisationPct}%` }}
                                                />
                                            </span>
                                            <span className={styles.loadPct}>{load.utilisationPct}%</span>
                                        </li>
                                    ))}
                            </ul>

                            {/* The table view: every job's placement in text, so the plan is
                                readable without relying on the colour channel. */}
                            <h3 className={styles.sectionTitle}>Placement order</h3>
                            <p className={styles.sectionNote}>
                                Dependencies first, then priority. Click a row to trace it on the grid.
                            </p>
                            <table className={styles.orderTable}>
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Job</th>
                                        <th>Starts</th>
                                        <th>Finishes</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {schedule.order.map((jobId, index) => {
                                        const job = jobs.find((candidate) => candidate.id === jobId);
                                        const color = jobColor(colors, jobId);
                                        return (
                                            <tr
                                                key={jobId}
                                                className={highlightedJobId === jobId ? styles.orderRowOn : ""}
                                            >
                                                <td>{index + 1}</td>
                                                <td>
                                                    <button
                                                        type="button"
                                                        className={styles.orderJobBtn}
                                                        onClick={() => toggleHighlight(jobId)}
                                                        aria-pressed={highlightedJobId === jobId}
                                                    >
                                                        <span
                                                            className={styles.orderSwatch}
                                                            style={{ background: color.fill }}
                                                        />
                                                        <span>
                                                            <strong>{jobId}</strong>
                                                            <br />
                                                            <span className={styles.orderJobName}>{job?.name}</span>
                                                        </span>
                                                    </button>
                                                </td>
                                                <td className={styles.numeric}>
                                                    {formatOffset(schedule.jobStart[jobId] ?? 0)}
                                                </td>
                                                <td className={styles.numeric}>
                                                    {formatOffset(schedule.jobFinish[jobId] ?? 0)}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>

                            <Link className={styles.simLink} href="/manager/simulation">
                                Run this plan in the simulation →
                            </Link>
                        </>
                    ) : (
                        <p className={styles.summaryEmpty}>
                            Generate a schedule to see its makespan, machine load and placement order.
                        </p>
                    )}
                </aside>
            </main>
        </div>
    );
}
