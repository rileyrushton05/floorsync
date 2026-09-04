"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, priorityTone, statusTone } from "../../_components/Badge";
import { Wordmark } from "../../_components/Logo";
import {
    IconAlertCircle,
    IconCalendar,
    IconChevronLeft, IconChevronRight,
    IconClock,
    IconMoreVertical,
    IconPause,
    IconPlay
} from "../icons";
import styles from "./scheduler.module.css";

interface ScheduledOperation {
    jobId: string;
    opIndex: number;
    opName: string;
    status: "running" | "scheduled" | "completed" | "delayed";
    startTime: number; // hour (0-23)
    duration: number; // hours
    machine: string;
}

interface SchedulerJob {
    id: string;
    name: string;
    priority: "High" | "Med" | "Low";
    status: "In Progress" | "Pending" | "Delayed";
    progress: number;
    currentOp: {
        index: number;
        total: number;
        name: string;
        state: "done" | "current" | "pending";
    };
    operations: string[];
    machine?: string;
    queueStatus?: string;
}

interface MachineSchedule {
    name: string;
    operator: string;
    status: "Active" | "Idle" | "Waiting";
    schedule: ScheduledOperation[];
}

/** Window the schedule grid renders, in 24-hour clock hours (08:00 -> 24:00). */
const TIMELINE_START_HOUR = 8;
const TIMELINE_HOURS = 16;
/** Width of the machine-name gutter. Must match `.machineLabel` in the stylesheet. */
const MACHINE_LABEL_WIDTH = "160px";
/** Simulation clock. Drives both the readout and the "now" line on the grid. */
const CURRENT_TIME_HOUR = 10 + 24 / 60;

/** 10.4 -> "10:24 AM" */
function formatClock(hour: number): string {
    const hours24 = Math.floor(hour);
    const minutes = Math.round((hour - hours24) * 60);
    const suffix = hours24 < 12 ? "AM" : "PM";
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
    return `${hours12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/** 8.5 -> "08:30", the value format `<input type="time">` expects. */
function toTimeInputValue(hour: number): string {
    const hours = Math.floor(hour);
    const minutes = Math.round((hour - hours) * 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** "08:30" -> 8.5 */
function fromTimeInputValue(value: string): number {
    const [hours, minutes] = value.split(":").map(Number);
    return hours + minutes / 60;
}

const schedulerData: { machines: MachineSchedule[]; jobs: SchedulerJob[] } = {
    machines: [
        {
            name: "Machine A",
            operator: "Anita Sandburg",
            status: "Active",
            schedule: [
                { jobId: "#255", opIndex: 1, opName: "Op 1", status: "completed", startTime: 8, duration: 1, machine: "Machine A" },
                { jobId: "#254", opIndex: 2, opName: "Op 2", status: "running", startTime: 9, duration: 2, machine: "Machine A" },
                { jobId: "#257", opIndex: 1, opName: "Op 1", status: "scheduled", startTime: 11, duration: 1, machine: "Machine A" },
            ],
        },
        {
            name: "Machine B",
            operator: "Chelsea",
            status: "Active",
            schedule: [
                { jobId: "#251", opIndex: 1, opName: "Op 1", status: "completed", startTime: 8, duration: 0.5, machine: "Machine B" },
                { jobId: "#253", opIndex: 1, opName: "Op 1", status: "completed", startTime: 8.5, duration: 1.5, machine: "Machine B" },
                { jobId: "#254", opIndex: 2, opName: "Op 2", status: "running", startTime: 10, duration: 2.5, machine: "Machine B" },
                { jobId: "#260", opIndex: 1, opName: "Op 1", status: "scheduled", startTime: 12.5, duration: 1.5, machine: "Machine B" },
            ],
        },
        {
            name: "Machine C",
            operator: "Fiona",
            status: "Idle",
            schedule: [
                { jobId: "#256", opIndex: 1, opName: "Op 1", status: "completed", startTime: 8, duration: 1.5, machine: "Machine C" },
                { jobId: "#258", opIndex: 1, opName: "Op 1", status: "completed", startTime: 9.5, duration: 1.5, machine: "Machine C" },
                { jobId: "#259", opIndex: 1, opName: "Op 1", status: "scheduled", startTime: 11, duration: 2, machine: "Machine C" },
            ],
        },
        {
            name: "Machine D",
            operator: "George",
            status: "Waiting",
            schedule: [
                { jobId: "#252", opIndex: 1, opName: "Op 1", status: "completed", startTime: 8.5, duration: 1.5, machine: "Machine D" },
                { jobId: "#257", opIndex: 2, opName: "Op 2", status: "scheduled", startTime: 10, duration: 1.5, machine: "Machine D" },
                { jobId: "#256", opIndex: 1, opName: "Op 1", status: "scheduled", startTime: 11.5, duration: 2, machine: "Machine D" },
            ],
        },
    ],

    jobs: [
        { id: "#254", name: "Dryer not working", priority: "High", status: "In Progress", progress: 60, currentOp: { index: 2, total: 5, name: "Adjusting Tension", state: "current" }, operations: ["Load Material", "Adjusting Tension", "Quality Check", "Final Test", "Unload & Clean"], machine: "Machine B", queueStatus: "Waiting for Machine B" },
        { id: "#255", name: "Washing Machine Issue", priority: "Med", status: "In Progress", progress: 40, currentOp: { index: 1, total: 4, name: "Diagnose Fault", state: "current" }, operations: ["Diagnose Fault", "Replace Belt", "Test Cycle", "Final Inspection"], machine: "Machine A", queueStatus: "Queued" },
        { id: "#256", name: "Forklift Maintenance", priority: "Low", status: "Pending", progress: 0, currentOp: { index: 1, total: 3, name: "Safety Check", state: "pending" }, operations: ["Safety Check", "Repair Hydraulics", "Test Drive"], queueStatus: "Queued" },
        { id: "#257", name: "Conveyor Belt Check", priority: "Med", status: "In Progress", progress: 80, currentOp: { index: 4, total: 5, name: "Test Run", state: "current" }, operations: ["Safety Lockout", "Inspect Rollers", "Lubricate Chain", "Test Run", "Sign Off"], machine: "Machine D", queueStatus: "In Queue" },
        { id: "#258", name: "Tool Replacement", priority: "High", status: "Delayed", progress: 0, currentOp: { index: 1, total: 2, name: "Remove Old Tool", state: "pending" }, operations: ["Remove Old Tool", "Install New Tool"], queueStatus: "Waiting for Material" }
    ],
};

type FilterType = "All" | "Pending" | "In Progress" | "Delayed";

const getOperationStatus = (
    operation: ScheduledOperation,
    jobStatus?: SchedulerJob["status"]
): ScheduledOperation["status"] => {
    if (!jobStatus) return operation.status;
    // Work that already finished stays "completed": delaying a job only
    // repaints the operations it has yet to run, never its history.
    if (operation.status === "completed") return "completed";
    if (jobStatus === "Delayed") return "delayed";
    return jobStatus === "In Progress" ? "running" : "scheduled";
};

interface EditFormData {
    name: string;
    priority: "High" | "Med" | "Low";
    status: "In Progress" | "Pending" | "Delayed";
    machine?: string;
    notes: string;
}

interface ScheduleEditData {
    machine: string;
    startTime: string;
    sourceMachine: string;
}

export default function SchedulerPage() {
    const [selectedDate, setSelectedDate] = useState(new Date(2019, 10, 15)); // Nov 15, 2019
    const [selectedJobId, setSelectedJobId] = useState<string>(schedulerData.jobs[0].id);
    const [isPlaying, setIsPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [filter, setFilter] = useState<FilterType>("All");
    const [showJobListHint, setShowJobListHint] = useState(true);
    const [jobs, setJobs] = useState<SchedulerJob[]>([...schedulerData.jobs]);
    const [editingJobId, setEditingJobId] = useState<string | null>(null);
    const [scheduleEditJobId, setScheduleEditJobId] = useState<string | null>(null);
    const [scheduleEdits, setScheduleEdits] = useState<Record<string, ScheduleEditData>>({});
    const [scheduleEditData, setScheduleEditData] = useState<ScheduleEditData>({ machine: "", startTime: "08:00", sourceMachine: "" });
    const [editFormData, setEditFormData] = useState<EditFormData>({
        name: "",
        priority: "Med",
        status: "Pending",
        notes: "",
    });

    // Escape dismisses whichever modal is open. Setters are stable, so this
    // effect only needs the two "is a modal open" flags as dependencies.
    useEffect(() => {
        if (!editingJobId && !scheduleEditJobId) return;
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setEditingJobId(null);
            setScheduleEditJobId(null);
        };
        window.addEventListener("keydown", handleEscape);
        return () => window.removeEventListener("keydown", handleEscape);
    }, [editingJobId, scheduleEditJobId]);

    const filteredJobs = useMemo(() => {
        if (filter === "All") return jobs;
        return jobs.filter((j) => j.status === filter);
    }, [filter, jobs]);

    const selectedJob = jobs.find((j) => j.id === selectedJobId) || jobs[0];

    const handleDateChange = (offset: number) => {
        const newDate = new Date(selectedDate);
        newDate.setDate(newDate.getDate() + offset);
        setSelectedDate(newDate);
    };

    const dateStr = selectedDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

    const handleOpenEditModal = (jobId: string) => {
        const job = jobs.find((j) => j.id === jobId);
        if (job) {
            setSelectedJobId(jobId);
            setEditingJobId(jobId);
            setEditFormData({
                name: job.name,
                priority: job.priority,
                status: job.status,
                machine: job.machine,
                notes: "",
            });
        }
    };

    const handleCloseEditModal = () => {
        setEditingJobId(null);
        setEditFormData({ name: "", priority: "Med", status: "Pending", notes: "" });
    };

    const handleSaveEdit = () => {
        if (!editingJobId) return;
        const updatedJobs = jobs.map((job) =>
            job.id === editingJobId
                ? {
                    ...job,
                    name: editFormData.name,
                    priority: editFormData.priority,
                    status: editFormData.status,
                    machine: editFormData.machine,
                }
                : job
        );
        setJobs(updatedJobs);
        handleCloseEditModal();
    };

    const handleFormChange = <K extends keyof EditFormData>(field: K, value: EditFormData[K]) => {
        setEditFormData((prev) => ({ ...prev, [field]: value }));
    };

    const handleOpenScheduleModal = () => {
        const currentOperation = schedulerData.machines
            .flatMap((machine) => machine.schedule)
            .find((operation) => operation.jobId === selectedJob.id && operation.opIndex === selectedJob.currentOp.index);
        const savedSchedule = scheduleEdits[selectedJob.id];
        setScheduleEditJobId(selectedJob.id);
        setScheduleEditData({
            machine: savedSchedule?.machine || selectedJob.machine || currentOperation?.machine || "Machine A",
            startTime: savedSchedule?.startTime || toTimeInputValue(currentOperation?.startTime ?? TIMELINE_START_HOUR),
            sourceMachine: savedSchedule?.sourceMachine || currentOperation?.machine || "Machine A",
        });
    };

    const handleCloseScheduleModal = () => {
        setScheduleEditJobId(null);
    };

    const handleSaveScheduleEdit = () => {
        if (!scheduleEditJobId) return;
        setScheduleEdits((previousEdits) => ({ ...previousEdits, [scheduleEditJobId]: scheduleEditData }));
        setScheduleEditJobId(null);
        setJobs((previousJobs) => previousJobs.map((job) =>
            job.id === scheduleEditJobId
                ? { ...job, machine: scheduleEditData.machine, queueStatus: `Scheduled on ${scheduleEditData.machine}` }
                : job
        ));
    };

    const handleDelayOperation = () => {
        setJobs((previousJobs) => previousJobs.map((job) =>
            job.id === selectedJob.id ? { ...job, status: "Delayed" as const } : job
        ));
    };

    return (
        <div className={styles.shell}>
            <header className={styles.topbar}>
                <div className={styles.brandGroup}>
                    <Wordmark />
                    <span className={styles.viewLabel}>Manager View - Scheduler</span>
                </div>

                <div className={styles.dateNav}>
                    <button className={styles.dateNavBtn} onClick={() => handleDateChange(-1)} aria-label="Previous day">
                        <IconChevronLeft />
                    </button>
                    <div className={styles.dateDisplay}>
                        <IconCalendar />
                        <span>{dateStr}</span>
                    </div>
                    <button className={styles.dateNavBtn} onClick={() => handleDateChange(1)} aria-label="Next day">
                        <IconChevronRight />
                    </button>
                </div>

                <div className={styles.playbackControls}>
                    <button
                        className={styles.playBtn}
                        onClick={() => setIsPlaying(!isPlaying)}
                        aria-label={isPlaying ? "Pause" : "Play"}
                    >
                        {isPlaying ? <IconPause /> : <IconPlay />}
                    </button>
                    <span className={styles.pauseLabel}>||</span>

                    <div className={styles.speedPill}>
                        <span className={styles.speedLabel}>Speed:</span>
                        {[
                            { label: "1x", value: 1 },
                            { label: "10x", value: 10 },
                            { label: "100x", value: 100 },
                        ].map((s) => (
                            <button
                                key={s.value}
                                className={`${styles.speedBtn} ${speed === s.value ? styles.speedBtnActive : ""}`}
                                onClick={() => setSpeed(s.value)}
                            >
                                {s.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className={styles.topbarSpacer} />

                <label className={styles.liveSimulation}>
                    <span className={styles.liveDot} />
                    Live Simulation
                </label>

                <button className={styles.generateBtn}>Generate Schedule</button>

                <button className={styles.menuBtn} aria-label="Menu">
                    <IconMoreVertical />
                </button>
            </header>

            <main className={styles.main}>
                <div className={styles.contentRow}>
                    <aside className={styles.leftPanel}>
                        <div className={styles.jobListHead}>
                            <h2 className={styles.panelTitle}>JOB LIST</h2>
                        </div>

                        <div className={styles.filterRow}>
                            {["All", "Pending", "In Progress", "Delayed"].map((f) => (
                                <button
                                    key={f}
                                    className={`${styles.filterBtn} ${filter === f ? styles.filterBtnActive : ""}`}
                                    onClick={() => setFilter(f as FilterType)}
                                >
                                    {f}
                                </button>
                            ))}
                        </div>

                        {showJobListHint && (
                            <div className={styles.jobListHint} role="status">
                                <span>Click a job card or schedule block to edit its properties.</span>
                                <button
                                    className={styles.jobListHintDismiss}
                                    onClick={() => setShowJobListHint(false)}
                                    aria-label="Dismiss job editing hint"
                                >
                                    ×
                                </button>
                            </div>
                        )}

                        <div className={styles.jobListContainer}>
                            {filteredJobs.map((job) => (
                                <button
                                    key={job.id}
                                    type="button"
                                    className={`${styles.jobCard} ${selectedJobId === job.id ? styles.jobCardActive : ""}`}
                                    onClick={() => handleOpenEditModal(job.id)}
                                    aria-label={`Edit job ${job.id}, ${job.name}`}
                                >
                                    <div className={styles.jobCardHead}>
                                        <span className={styles.jobId}>{job.id}</span>
                                        <Badge tone={priorityTone(job.priority)}>
                                            {job.priority}
                                        </Badge>
                                    </div>
                                    <div className={styles.jobName}>{job.name}</div>
                                    <div className={styles.jobMeta}>
                                        Op {job.currentOp.index} of {job.currentOp.total} • {job.queueStatus}
                                    </div>
                                    <div className={styles.jobStatus}>
                                        <span className={`${styles.statusDot} ${styles[`status_${job.status.toLowerCase().replace(" ", "")}`]}`} />
                                        {job.status}
                                    </div>
                                </button>
                            ))}
                        </div>

                        <button className={styles.addJobBtn}>+ Add New Job</button>
                    </aside>

                    <section className={styles.centerPanel}>
                        <div className={styles.timelineHead}>
                            <h2 className={styles.panelTitle}>SCHEDULE TIMELINE</h2>
                            <div className={styles.currentTime}>Current Time {formatClock(CURRENT_TIME_HOUR)}</div>
                        </div>

                        <div className={styles.timelineContainer}>
                            <div className={styles.timelineContent}>
                                {/* Time markers */}
                                <div className={styles.timeMarkersRow}>
                                    <div className={styles.machineLabel} />
                                    {Array.from({ length: TIMELINE_HOURS }).map((_, i) => (
                                        <div key={i} className={styles.timeMarker}>
                                            {String(TIMELINE_START_HOUR + i).padStart(2, "0")}:00
                                        </div>
                                    ))}
                                </div>

                                {/* Machine rows */}
                                {schedulerData.machines.map((machine) => (
                                    <div key={machine.name} className={styles.machineRow}>
                                        <div className={styles.machineLabel}>
                                            <div className={styles.machineName}>{machine.name}</div>
                                            <div className={styles.operatorName}>{machine.operator}</div>
                                        </div>
                                        <div className={styles.timelineRowContent}>
                                            {machine.schedule.map((op, idx) => {
                                                const job = jobs.find((item) => item.id === op.jobId);
                                                const savedSchedule = scheduleEdits[op.jobId];
                                                const operationEdit = scheduleEditJobId === op.jobId ? scheduleEditData : savedSchedule;
                                                const isEditedOperation = Boolean(operationEdit) && op.opIndex === job?.currentOp.index;
                                                const isOriginalMachine = !isEditedOperation || op.machine === operationEdit?.sourceMachine;
                                                if (!isOriginalMachine) return null;
                                                const editedStartTime = isEditedOperation && operationEdit
                                                    ? fromTimeInputValue(operationEdit.startTime)
                                                    : op.startTime;
                                                const editedMachine = isEditedOperation && operationEdit
                                                    ? operationEdit.machine
                                                    : op.machine;
                                                if (editedMachine !== machine.name) return null;
                                                const startPct = ((editedStartTime - TIMELINE_START_HOUR) / TIMELINE_HOURS) * 100;
                                                const widthPct = (op.duration / TIMELINE_HOURS) * 100;
                                                const operationStatus = getOperationStatus(op, job?.status);
                                                return (
                                                    <button
                                                        key={idx}
                                                        type="button"
                                                        className={`${styles.scheduledOp} ${styles[`opStatus_${operationStatus}`]}`}
                                                        style={{
                                                            left: `${startPct}%`,
                                                            width: `${widthPct}%`,
                                                        }}
                                                        onClick={() => handleOpenEditModal(op.jobId)}
                                                        title={`${op.jobId} - ${op.opName}`}
                                                        aria-label={`${op.jobId} ${op.opName} on ${machine.name}, ${formatClock(editedStartTime)} for ${op.duration}h — edit`}
                                                    >
                                                        <div className={styles.opLabel}>
                                                            {op.jobId}
                                                            <br />
                                                            {op.opName}
                                                        </div>
                                                    </button>
                                                );
                                            })}

                                        </div>
                                    </div>
                                ))}

                                {/* "Now" line. Offset past the machine-name gutter so it lands on the
                                    right hour of the grid rather than of the whole row. */}
                                <div
                                    className={styles.currentTimeIndicator}
                                    style={{
                                        left: `calc(${MACHINE_LABEL_WIDTH} + ${(CURRENT_TIME_HOUR - TIMELINE_START_HOUR) / TIMELINE_HOURS} * (100% - ${MACHINE_LABEL_WIDTH}))`,
                                    }}
                                />
                            </div>
                        </div>

                        <div className={styles.timelineLegend}>
                            <div className={styles.legendItem}>
                                <div className={`${styles.legendDot} ${styles.legendDotRunning}`} /> Running
                            </div>
                            <div className={styles.legendItem}>
                                <div className={`${styles.legendDot} ${styles.legendDotScheduled}`} /> Scheduled
                            </div>
                            <div className={styles.legendItem}>
                                <div className={`${styles.legendDot} ${styles.legendDotCompleted}`} /> Completed
                            </div>
                            <div className={styles.legendItem}>
                                <div className={`${styles.legendDot} ${styles.legendDotDelayed}`} /> Delayed
                            </div>
                        </div>

                        <div className={styles.machineStatusSection}>
                            <h3 className={styles.machineStatusTitle}>MACHINE STATUS</h3>
                            <div className={styles.machineStatusGrid}>
                                {schedulerData.machines.map((machine) => (
                                    <div key={machine.name} className={styles.machineStatusItem}>
                                        <div
                                            className={`${styles.statusIndicator} ${styles[`machineStatus_${machine.status.toLowerCase()}`]}`}
                                        />
                                        <span className={styles.machineStatusName}>{machine.name}</span>
                                        <span className={styles.machineStatusValue}>{machine.status}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </section>

                    <aside className={styles.rightPanel}>
                        <div className={styles.detailsHead}>
                            <div>
                                <div className={styles.jobLabel}>Job {selectedJob.id}</div>
                                <h2 className={styles.jobTitle}>{selectedJob.name}</h2>
                            </div>
                            <Badge tone={statusTone(selectedJob.status)}>{selectedJob.status}</Badge>
                        </div>

                        <div className={styles.operationFlowSection}>
                            <h3 className={styles.sectionTitle}>OPERATION FLOW</h3>
                            <div className={styles.operationFlow}>
                                {selectedJob.operations.map((op, idx) => {
                                    const opNum = idx + 1;
                                    const isComplete = opNum < selectedJob.currentOp.index;
                                    const isCurrent = opNum === selectedJob.currentOp.index;
                                    return (
                                        <div key={idx} className={styles.flowItem}>
                                            <div
                                                className={`${styles.flowIndex} ${isCurrent ? styles.flowIndexCurrent : isComplete ? styles.flowIndexComplete : ""}`}
                                            >
                                                {isComplete ? "✓" : opNum}
                                            </div>
                                            <span className={styles.flowText}>{op}</span>
                                            {idx < selectedJob.operations.length - 1 && <span className={styles.flowArrow}>→</span>}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className={styles.currentOpSection}>
                            <h3 className={styles.sectionTitle}>CURRENT OPERATION</h3>
                            <div className={styles.currentOpCard}>
                                <div className={styles.opCardRow}>
                                    <span className={styles.opCardLabel}>Machine:</span>
                                    <span className={styles.opCardValue}>{selectedJob.machine || "–"}</span>
                                </div>
                                <div className={styles.opCardRow}>
                                    <span className={styles.opCardLabel}>Operation:</span>
                                    <span className={styles.opCardValue}>
                                        Op {selectedJob.currentOp.index} – {selectedJob.currentOp.name}
                                    </span>
                                </div>
                                <div className={styles.opCardRow}>
                                    <span className={styles.opCardLabel}>Started:</span>
                                    <span className={styles.opCardValue}>09:58 AM</span>
                                </div>
                                <div className={styles.opCardRow}>
                                    <span className={styles.opCardLabel}>Est. End:</span>
                                    <span className={styles.opCardValue}>11:02 AM</span>
                                </div>
                                <div className={styles.opCardRow}>
                                    <span className={styles.opCardLabel}>Progress:</span>
                                    <div className={styles.progressBar}>
                                        <div className={styles.progressFill} style={{ width: `${selectedJob.progress}%` }} />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className={styles.scheduleActionsSection}>
                            <h3 className={styles.sectionTitle}>SCHEDULE ACTIONS</h3>
                            <button className={styles.actionBtn} onClick={handleOpenScheduleModal}>Change Machine / Time</button>
                            <button className={styles.actionBtnDanger} onClick={handleDelayOperation}>Delay Operation</button>
                            <div className={styles.actionHint}>(Schedule is editable while simulation is paused)</div>
                        </div>

                        <div className={styles.alertsSection}>
                            <h3 className={styles.sectionTitle}>ALERTS</h3>
                            <div className={styles.alertsList}>
                                <div className={styles.alertItem}>
                                    <div className={styles.alertIconError}>
                                        <IconAlertCircle />
                                    </div>
                                    <div className={styles.alertContent}>
                                        <div className={styles.alertTitle}>Job #258 is delayed</div>
                                        <div className={styles.alertMsg}>Waiting for material for 45 mins</div>
                                    </div>
                                </div>
                                <div className={styles.alertItem}>
                                    <div className={styles.alertIconWarning}>
                                        <IconClock />
                                    </div>
                                    <div className={styles.alertContent}>
                                        <div className={styles.alertTitle}>Machine C is idle</div>
                                        <div className={styles.alertMsg}>No jobs scheduled until 11:20 AM</div>
                                    </div>
                                </div>
                            </div>
                            <button className={styles.viewAllAlertsBtn}>View all alerts →</button>
                        </div>
                    </aside>
                </div>
            </main>

            {/* EDIT JOB MODAL */}
            {editingJobId && (
                <div className={styles.modalBackdrop} onClick={handleCloseEditModal}>
                    <div
                        className={styles.modalDialog}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="edit-job-modal-title"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className={styles.modalHead}>
                            <h2 className={styles.modalTitle} id="edit-job-modal-title">Edit Job {editingJobId}</h2>
                            <button className={styles.modalCloseBtn} onClick={handleCloseEditModal} aria-label="Close job editor">✕</button>
                        </div>

                        <div className={styles.modalContent}>
                            <div className={styles.formGroup}>
                                <label className={styles.formLabel} htmlFor="edit-job-name">Job Name</label>
                                <input
                                    id="edit-job-name"
                                    type="text"
                                    className={styles.formInput}
                                    value={editFormData.name}
                                    onChange={(e) => handleFormChange("name", e.target.value)}
                                />
                            </div>

                            <div className={styles.formRow}>
                                <div className={styles.formGroup}>
                                    <label className={styles.formLabel} htmlFor="edit-job-priority">Priority</label>
                                    <select
                                        id="edit-job-priority"
                                        className={styles.formSelect}
                                        value={editFormData.priority}
                                        onChange={(e) => handleFormChange("priority", e.target.value as EditFormData["priority"])}
                                    >
                                        <option>High</option>
                                        <option>Med</option>
                                        <option>Low</option>
                                    </select>
                                </div>

                                <div className={styles.formGroup}>
                                    <label className={styles.formLabel} htmlFor="edit-job-status">Status</label>
                                    <select
                                        id="edit-job-status"
                                        className={styles.formSelect}
                                        value={editFormData.status}
                                        onChange={(e) => handleFormChange("status", e.target.value as EditFormData["status"])}
                                    >
                                        <option>Pending</option>
                                        <option>In Progress</option>
                                        <option>Delayed</option>
                                    </select>
                                </div>
                            </div>

                            <div className={styles.formGroup}>
                                <label className={styles.formLabel} htmlFor="edit-job-machine">Assigned Machine</label>
                                <select
                                    id="edit-job-machine"
                                    className={styles.formSelect}
                                    value={editFormData.machine || ""}
                                    onChange={(e) => handleFormChange("machine", e.target.value || undefined)}
                                >
                                    <option value="">Unassigned</option>
                                    <option>Machine A</option>
                                    <option>Machine B</option>
                                    <option>Machine C</option>
                                    <option>Machine D</option>
                                </select>
                            </div>

                            <div className={styles.formGroup}>
                                <label className={styles.formLabel} htmlFor="edit-job-notes">Notes</label>
                                <textarea
                                    id="edit-job-notes"
                                    className={styles.formTextarea}
                                    value={editFormData.notes}
                                    onChange={(e) => handleFormChange("notes", e.target.value)}
                                    placeholder="Add notes about this job..."
                                    rows={3}
                                />
                            </div>
                        </div>

                        <div className={styles.modalFooter}>
                            <button className={styles.modalBtnCancel} onClick={handleCloseEditModal}>Cancel</button>
                            <button className={styles.modalBtnSave} onClick={handleSaveEdit}>Save Changes</button>
                        </div>
                    </div>
                </div>
            )}

            {scheduleEditJobId && (
                <div className={styles.modalBackdrop} onClick={handleCloseScheduleModal}>
                    <div
                        className={styles.modalDialog}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="schedule-modal-title"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className={styles.modalHead}>
                            <h2 className={styles.modalTitle} id="schedule-modal-title">Change Machine / Time</h2>
                            <button className={styles.modalCloseBtn} onClick={handleCloseScheduleModal} aria-label="Close schedule editor">✕</button>
                        </div>

                        <div className={styles.modalContent}>
                            <div className={styles.scheduleModalJob}>
                                <span className={styles.formLabel}>Job</span>
                                <strong>{selectedJob.id} - {selectedJob.currentOp.name}</strong>
                            </div>

                            <div className={styles.formGroup}>
                                <label className={styles.formLabel} htmlFor="schedule-machine">Machine</label>
                                <select
                                    id="schedule-machine"
                                    className={styles.formSelect}
                                    value={scheduleEditData.machine}
                                    onChange={(e) => setScheduleEditData((previous) => ({ ...previous, machine: e.target.value }))}
                                >
                                    <option>Machine A</option>
                                    <option>Machine B</option>
                                    <option>Machine C</option>
                                    <option>Machine D</option>
                                </select>
                            </div>

                            <div className={styles.formGroup}>
                                <label className={styles.formLabel} htmlFor="schedule-start-time">Start time</label>
                                <input
                                    id="schedule-start-time"
                                    type="time"
                                    className={styles.formInput}
                                    value={scheduleEditData.startTime}
                                    onChange={(e) => setScheduleEditData((previous) => ({ ...previous, startTime: e.target.value }))}
                                />
                            </div>
                        </div>

                        <div className={styles.modalFooter}>
                            <button className={styles.modalBtnCancel} onClick={handleCloseScheduleModal}>Cancel</button>
                            <button className={styles.modalBtnSave} onClick={handleSaveScheduleEdit}>Save Changes</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
