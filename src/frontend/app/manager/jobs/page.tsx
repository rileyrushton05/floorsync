"use client";

import { useMemo, useRef, useState } from "react";
import { Badge, priorityTone } from "../../_components/Badge";
import { Wordmark } from "../../_components/Logo";
import { usePlanning } from "../_components/PlanningProvider";
import { SubNav } from "../_components/SubNav";
import { buildJobColors, jobColor } from "../_lib/colors";
import { dependentsOf, formatDuration, totalWorkMins, wouldCreateCycle } from "../_lib/scheduling";
import type { JobDef, OperationDef, Priority } from "../_lib/types";
import { IconUser } from "../icons";
import styles from "./jobs.module.css";

/** The job being written, before it is committed to the backlog. */
interface Draft {
    /** null while creating; a job id while editing an existing job. */
    id: string | null;
    name: string;
    priority: Priority;
    operations: OperationDef[];
    dependsOn: string[];
}

const EMPTY_DRAFT: Draft = { id: null, name: "", priority: "Med", operations: [], dependsOn: [] };

function draftFrom(job: JobDef): Draft {
    return {
        id: job.id,
        name: job.name,
        priority: job.priority,
        operations: job.operations.map((op) => ({ ...op })),
        dependsOn: [...job.dependsOn],
    };
}

export default function JobsPage() {
    const { machines, jobs, createJob, updateJob, deleteJob } = usePlanning();
    const [draft, setDraft] = useState<Draft>(() => (jobs.length > 0 ? draftFrom(jobs[0]) : EMPTY_DRAFT));
    const [errors, setErrors] = useState<string[]>([]);
    const [savedNotice, setSavedNotice] = useState<string | null>(null);
    // Operations are only ever created by a click, so a plain counter is a safe
    // key source — no ids are generated during render.
    const opCounter = useRef(0);

    const colors = useMemo(() => buildJobColors(jobs), [jobs]);
    const machineName = (id: string) => machines.find((machine) => machine.id === id)?.name ?? "—";

    const draftWorkMins = draft.operations.reduce((total, op) => total + op.durationMins, 0);
    const blockedBy = draft.id ? dependentsOf(jobs, draft.id) : [];

    function startNewJob() {
        setDraft(EMPTY_DRAFT);
        setErrors([]);
        setSavedNotice(null);
    }

    function editJob(job: JobDef) {
        setDraft(draftFrom(job));
        setErrors([]);
        setSavedNotice(null);
    }

    function addOperation() {
        opCounter.current += 1;
        setDraft((previous) => ({
            ...previous,
            operations: [
                ...previous.operations,
                {
                    id: `new-op-${opCounter.current}`,
                    name: "",
                    machineId: machines[0]?.id ?? "",
                    durationMins: 30,
                },
            ],
        }));
    }

    function patchOperation(index: number, patch: Partial<OperationDef>) {
        setDraft((previous) => ({
            ...previous,
            operations: previous.operations.map((op, i) => (i === index ? { ...op, ...patch } : op)),
        }));
    }

    function removeOperation(index: number) {
        setDraft((previous) => ({
            ...previous,
            operations: previous.operations.filter((_, i) => i !== index),
        }));
    }

    /** Reordering matters: operations run in array order, so this edits precedence. */
    function moveOperation(index: number, offset: number) {
        const target = index + offset;
        setDraft((previous) => {
            if (target < 0 || target >= previous.operations.length) return previous;
            const operations = [...previous.operations];
            [operations[index], operations[target]] = [operations[target], operations[index]];
            return { ...previous, operations };
        });
    }

    function toggleDependency(jobId: string) {
        setDraft((previous) => ({
            ...previous,
            dependsOn: previous.dependsOn.includes(jobId)
                ? previous.dependsOn.filter((id) => id !== jobId)
                : [...previous.dependsOn, jobId],
        }));
    }

    function validateDraft(): string[] {
        const found: string[] = [];
        if (draft.name.trim() === "") found.push("Give the job a name.");
        if (draft.operations.length === 0) found.push("Add at least one operation.");
        draft.operations.forEach((op, index) => {
            if (op.name.trim() === "") found.push(`Operation ${index + 1} needs a name.`);
            if (!(op.durationMins > 0)) found.push(`Operation ${index + 1} needs a duration greater than zero.`);
        });
        return found;
    }

    function saveDraft() {
        const found = validateDraft();
        setErrors(found);
        if (found.length > 0) return;

        const payload = {
            name: draft.name.trim(),
            priority: draft.priority,
            operations: draft.operations.map((op) => ({ ...op, name: op.name.trim() })),
            dependsOn: draft.dependsOn,
        };

        if (draft.id) {
            updateJob(draft.id, payload);
            setSavedNotice(`${draft.id} saved.`);
        } else {
            const id = createJob({ ...payload, dependsOn: payload.dependsOn });
            setDraft((previous) => ({ ...previous, id }));
            setSavedNotice(`${id} created and added to the selection.`);
        }
    }

    function removeJob() {
        if (!draft.id) return;
        const removedId = draft.id;
        deleteJob(removedId);
        setDraft(EMPTY_DRAFT);
        setErrors([]);
        setSavedNotice(`${removedId} deleted.`);
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
                <button className={styles.newJobBtn} onClick={startNewJob}>+ New job</button>
                <div className={styles.userBlock}>
                    <IconUser />
                    <span className={styles.userName}>Manager</span>
                </div>
            </header>

            <main className={styles.main}>
                <aside className={styles.backlogPanel}>
                    <div className={styles.panelHead}>
                        <h2 className={styles.panelTitle}>Job backlog</h2>
                        <span className={styles.countPill}>{jobs.length}</span>
                    </div>
                    <p className={styles.panelHint}>
                        Jobs defined here are what the scheduler draws from. Nothing is scheduled until you
                        select jobs and generate a plan.
                    </p>

                    <ul className={styles.backlogList}>
                        {jobs.map((job) => {
                            const color = jobColor(colors, job.id);
                            return (
                                <li key={job.id}>
                                    <button
                                        type="button"
                                        className={`${styles.backlogCard} ${draft.id === job.id ? styles.backlogCardActive : ""}`}
                                        onClick={() => editJob(job)}
                                        aria-current={draft.id === job.id || undefined}
                                    >
                                        <span className={styles.backlogSwatch} style={{ background: color.fill }} />
                                        <span className={styles.backlogBody}>
                                            <span className={styles.backlogHead}>
                                                <span className={styles.backlogId}>{job.id}</span>
                                                <Badge tone={priorityTone(job.priority)}>{job.priority}</Badge>
                                            </span>
                                            <span className={styles.backlogName}>{job.name}</span>
                                            <span className={styles.backlogMeta}>
                                                {job.operations.length} ops · {formatDuration(totalWorkMins(job))} of work
                                            </span>
                                            {job.dependsOn.length > 0 && (
                                                <span className={styles.backlogDeps}>
                                                    after {job.dependsOn.join(", ")}
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                        {jobs.length === 0 && (
                            <li className={styles.backlogEmpty}>No jobs yet. Create one to get started.</li>
                        )}
                    </ul>
                </aside>

                <section className={styles.editorPanel}>
                    <div className={styles.panelHead}>
                        <h2 className={styles.panelTitle}>
                            {draft.id ? `Edit ${draft.id}` : "New job"}
                        </h2>
                        {draft.id && <span className={styles.editorMeta}>{draft.operations.length} operations</span>}
                    </div>

                    {errors.length > 0 && (
                        <div className={styles.errorBox} role="alert">
                            <strong>Fix before saving</strong>
                            <ul>
                                {errors.map((error) => <li key={error}>{error}</li>)}
                            </ul>
                        </div>
                    )}
                    {savedNotice && errors.length === 0 && (
                        <div className={styles.noticeBox} role="status">{savedNotice}</div>
                    )}

                    <div className={styles.formRow}>
                        <div className={styles.formGroup} style={{ flex: 2 }}>
                            <label className={styles.formLabel} htmlFor="job-name">Job name</label>
                            <input
                                id="job-name"
                                className={styles.formInput}
                                value={draft.name}
                                onChange={(e) => setDraft((previous) => ({ ...previous, name: e.target.value }))}
                                placeholder="e.g. Dryer not working"
                            />
                        </div>
                        <div className={styles.formGroup}>
                            <label className={styles.formLabel} htmlFor="job-priority">Priority</label>
                            <select
                                id="job-priority"
                                className={styles.formSelect}
                                value={draft.priority}
                                onChange={(e) =>
                                    setDraft((previous) => ({ ...previous, priority: e.target.value as Priority }))
                                }
                            >
                                <option>High</option>
                                <option>Med</option>
                                <option>Low</option>
                            </select>
                        </div>
                    </div>

                    <div className={styles.sectionHead}>
                        <h3 className={styles.sectionTitle}>Operations</h3>
                        <span className={styles.sectionNote}>
                            Run top to bottom — each step waits for the one above it
                        </span>
                    </div>

                    <ol className={styles.opList}>
                        {draft.operations.map((op, index) => (
                            <li key={op.id} className={styles.opRow}>
                                <span className={styles.opIndex}>{index + 1}</span>
                                <input
                                    className={styles.opName}
                                    value={op.name}
                                    onChange={(e) => patchOperation(index, { name: e.target.value })}
                                    placeholder="Operation name"
                                    aria-label={`Operation ${index + 1} name`}
                                />
                                <select
                                    className={styles.opMachine}
                                    value={op.machineId}
                                    onChange={(e) => patchOperation(index, { machineId: e.target.value })}
                                    aria-label={`Operation ${index + 1} machine`}
                                >
                                    {machines.map((machine) => (
                                        <option key={machine.id} value={machine.id}>{machine.name}</option>
                                    ))}
                                </select>
                                <span className={styles.opDurationWrap}>
                                    <input
                                        type="number"
                                        min={1}
                                        step={5}
                                        className={styles.opDuration}
                                        value={op.durationMins}
                                        onChange={(e) => patchOperation(index, { durationMins: Number(e.target.value) })}
                                        aria-label={`Operation ${index + 1} duration in minutes`}
                                    />
                                    <span className={styles.opDurationUnit}>min</span>
                                </span>
                                <span className={styles.opActions}>
                                    <button
                                        type="button"
                                        className={styles.opMoveBtn}
                                        onClick={() => moveOperation(index, -1)}
                                        disabled={index === 0}
                                        aria-label={`Move operation ${index + 1} earlier`}
                                    >↑</button>
                                    <button
                                        type="button"
                                        className={styles.opMoveBtn}
                                        onClick={() => moveOperation(index, 1)}
                                        disabled={index === draft.operations.length - 1}
                                        aria-label={`Move operation ${index + 1} later`}
                                    >↓</button>
                                    <button
                                        type="button"
                                        className={styles.opRemoveBtn}
                                        onClick={() => removeOperation(index)}
                                        aria-label={`Remove operation ${index + 1}`}
                                    >✕</button>
                                </span>
                            </li>
                        ))}
                        {draft.operations.length === 0 && (
                            <li className={styles.opEmpty}>No operations yet — a job needs at least one.</li>
                        )}
                    </ol>

                    <button className={styles.addOpBtn} onClick={addOperation}>+ Add operation</button>

                    <div className={styles.sectionHead}>
                        <h3 className={styles.sectionTitle}>Dependencies</h3>
                        <span className={styles.sectionNote}>
                            This job cannot start until every job ticked here has finished
                        </span>
                    </div>

                    <ul className={styles.depList}>
                        {jobs
                            .filter((candidate) => candidate.id !== draft.id)
                            .map((candidate) => {
                                // Ticking a job that already depends on this one would
                                // close a loop no ordering can satisfy, so block it here
                                // rather than failing at generation time.
                                const cyclic = draft.id !== null && wouldCreateCycle(jobs, draft.id, candidate.id);
                                const checked = draft.dependsOn.includes(candidate.id);
                                return (
                                    <li key={candidate.id}>
                                        <label className={`${styles.depItem} ${cyclic ? styles.depItemBlocked : ""}`}>
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                disabled={cyclic}
                                                onChange={() => toggleDependency(candidate.id)}
                                            />
                                            <span className={styles.depId}>{candidate.id}</span>
                                            <span className={styles.depName}>{candidate.name}</span>
                                            {cyclic && (
                                                <span className={styles.depBlockedNote}>
                                                    already waits on this job
                                                </span>
                                            )}
                                        </label>
                                    </li>
                                );
                            })}
                        {jobs.filter((candidate) => candidate.id !== draft.id).length === 0 && (
                            <li className={styles.depEmpty}>No other jobs to depend on yet.</li>
                        )}
                    </ul>

                    {blockedBy.length > 0 && (
                        <p className={styles.blocksNote}>
                            <strong>{blockedBy.length} job{blockedBy.length === 1 ? "" : "s"}</strong> wait on this one:{" "}
                            {blockedBy.map((job) => job.id).join(", ")}
                        </p>
                    )}

                    <div className={styles.editorFooter}>
                        <div className={styles.draftSummary}>
                            {draft.operations.length} operations · {formatDuration(draftWorkMins)} of machine time ·{" "}
                            {new Set(draft.operations.map((op) => machineName(op.machineId))).size} machines
                        </div>
                        <div className={styles.editorActions}>
                            {draft.id && (
                                <button className={styles.deleteBtn} onClick={removeJob}>Delete job</button>
                            )}
                            <button className={styles.saveBtn} onClick={saveDraft}>
                                {draft.id ? "Save changes" : "Create job"}
                            </button>
                        </div>
                    </div>
                </section>
            </main>
        </div>
    );
}
