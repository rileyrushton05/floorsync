"use client";

import { useState } from "react";
import { Wordmark } from "../_components/Logo";
import { Badge, priorityTone } from "../_components/Badge";
import styles from "./coordinator.module.css";

type JobPriority = "High" | "Med" | "Low";
type JobStatus = "Pending" | "In Progress" | "Completed" | "Delayed";

interface QueueJob {
  id: string;
  title: string;
  priority: JobPriority;
  status: string;
  currentStep: string;
  tab: JobStatus;
}

const queueJobs: QueueJob[] = [
  { id: "#254", title: "Dryer not working", priority: "High", status: "Waits for Machine 3", currentStep: "Op 2 / 5", tab: "In Progress" },
  { id: "#258", title: "Washing machine issue", priority: "Med", status: "Pending", currentStep: "Op 1 / 4", tab: "Pending" },
  { id: "#251", title: "Oven not heating", priority: "Low", status: "In Progress", currentStep: "Op 3 / 6", tab: "In Progress" },
  { id: "#252", title: "Dishwasher leak", priority: "High", status: "In Progress", currentStep: "Op 4 / 5", tab: "In Progress" },
  { id: "#253", title: "Fridge not cooling", priority: "Med", status: "Pending", currentStep: "Op 1 / 3", tab: "Pending" },
];

type BlockStatus = "pending" | "active" | "completed" | "delayed";

interface TimelineBlock {
  job: string;
  op: string;
  start: string;
  end: string;
  status: BlockStatus;
  active?: boolean;
}

interface MachineRow {
  name: string;
  operator: string;
  state: "Active" | "Waiting for Material" | "Idle";
  blocks: TimelineBlock[];
}

const DAY_START = 8 * 60;
const DAY_END = 15 * 60 + 30;
const HOUR_TICKS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"];
const CURRENT_TIME = "09:35 AM";

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function leftPct(hhmm: string): number {
  return ((toMinutes(hhmm) - DAY_START) / (DAY_END - DAY_START)) * 100;
}
function widthPct(start: string, end: string): number {
  return ((toMinutes(end) - toMinutes(start)) / (DAY_END - DAY_START)) * 100;
}

const machineRows: MachineRow[] = [
  {
    name: "Machine A",
    operator: "Anita Sandburg",
    state: "Active",
    blocks: [
      { job: "#250", op: "Op 2", start: "08:00", end: "09:00", status: "completed" },
      { job: "#251", op: "Op 3", start: "09:00", end: "10:15", status: "pending" },
      { job: "#255", op: "Op 1", start: "12:00", end: "13:00", status: "completed" },
    ],
  },
  {
    name: "Machine B",
    operator: "Chelsea",
    state: "Active",
    blocks: [
      { job: "#252", op: "Op 1", start: "08:00", end: "09:00", status: "completed" },
      { job: "#254", op: "Op 2 (ACTIVE)", start: "09:00", end: "10:30", status: "active", active: true },
      { job: "#256", op: "Op 1", start: "12:00", end: "13:00", status: "pending" },
    ],
  },
  {
    name: "Machine C",
    operator: "Fiona",
    state: "Waiting for Material",
    blocks: [
      { job: "#251", op: "Op 1", start: "08:00", end: "09:00", status: "pending" },
      { job: "#253", op: "Op 1", start: "09:00", end: "10:00", status: "pending" },
      { job: "#255", op: "Op 2", start: "11:00", end: "12:15", status: "pending" },
      { job: "#258", op: "Op 1", start: "13:00", end: "14:00", status: "completed" },
    ],
  },
  {
    name: "Machine D",
    operator: "George",
    state: "Active",
    blocks: [
      { job: "#256", op: "Op 2", start: "09:30", end: "10:30", status: "pending" },
      { job: "#257", op: "Op 1", start: "11:00", end: "12:15", status: "pending" },
    ],
  },
  {
    name: "Machine E",
    operator: "Hannah",
    state: "Idle",
    blocks: [
      { job: "#259", op: "Op 1", start: "09:30", end: "10:30", status: "pending" },
      { job: "#260", op: "Op 1", start: "11:00", end: "12:00", status: "pending" },
    ],
  },
];

const operationSequence = [
  { n: 1, label: "Pending", done: true },
  { n: 2, label: "Running", current: true },
  { n: 3, label: "Queued" },
  { n: 4, label: "Pending" },
  { n: 5, label: "Pending" },
];

const alerts = [
  { tone: "red" as const, title: "Machine C is overloaded", detail: "3 jobs queued beyond capacity." },
  { tone: "amber" as const, title: "Job #254 is behind schedule", detail: "Estimated delay: 15 minutes." },
  { tone: "blue" as const, title: "Material stock low", detail: "Part #A23 for Job #255" },
];

const tabs: (JobStatus | "All Jobs")[] = ["All Jobs", "Pending", "In Progress", "Completed", "Delayed"];

export default function CoordinatorDashboard() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("All Jobs");
  const [selectedJob, setSelectedJob] = useState(queueJobs[0]);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<"1x" | "10x" | "100x">("1x");

  const visibleJobs = activeTab === "All Jobs" ? queueJobs : queueJobs.filter((j) => j.tab === activeTab);

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Wordmark />
        <div className={styles.dateNav}>
          <button className={styles.iconBtn} aria-label="Previous day">‹</button>
          <span>Today, Friday, 15 November 2019</span>
          <button className={styles.iconBtn} aria-label="Next day">›</button>
        </div>
        <div className={styles.playback}>
          <button
            className={`${styles.iconBtn} ${styles.playBtn}`}
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <span className={styles.speedLabel}>Speed:</span>
          <div className={styles.speedGroup}>
            {(["1x", "10x", "100x"] as const).map((s) => (
              <button
                key={s}
                className={`${styles.speedBtn} ${speed === s ? styles.speedActive : ""}`}
                onClick={() => setSpeed(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.simStatus}>
          <span className={styles.liveDot} /> Live Simulation Running
        </div>
        <div className={styles.actions}>
          <button className={styles.btnGhost}>Generate Schedule</button>
          <button className={styles.btnGhost}>Handoff to Floor</button>
          <button className={styles.btnPrimary}>Export ▾</button>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.leftPanel}>
          <h2 className={styles.panelTitle}>Job Queue &amp; Schedule Builder</h2>
          <div className={styles.tabs}>
            {tabs.map((t) => (
              <button
                key={t}
                className={`${styles.tab} ${activeTab === t ? styles.tabActive : ""}`}
                onClick={() => setActiveTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div className={styles.jobList}>
            {visibleJobs.map((job) => (
              <button
                key={job.id}
                className={`${styles.jobCard} ${selectedJob.id === job.id ? styles.jobCardActive : ""}`}
                onClick={() => setSelectedJob(job)}
              >
                <div className={styles.jobCardTop}>
                  <span className={styles.jobId}>{job.id}</span>
                  <Badge tone={priorityTone(job.priority)}>{job.priority}</Badge>
                </div>
                <p className={styles.jobTitle}>{job.title}</p>
                <div className={styles.jobMeta}>
                  <span>Status:</span>
                  <span className={styles.jobMetaValue}>{job.status}</span>
                </div>
                <div className={styles.jobMeta}>
                  <span>Current Step:</span>
                  <span className={styles.jobMetaValue}>{job.currentStep}</span>
                </div>
              </button>
            ))}
          </div>
          <button className={styles.addJobBtn}>+ Add New Job</button>
        </aside>

        <section className={styles.timelinePanel}>
          <div className={styles.timelineHeaderRow}>
            <h2 className={styles.panelTitle}>Master Timeline Grid (All Machines)</h2>
            <span className={styles.currentTimeLabel}>Current Time: {CURRENT_TIME}</span>
          </div>

          <div className={styles.ruler}>
            <div className={styles.rulerSpacer} />
            <div className={styles.rulerTrack}>
              {HOUR_TICKS.map((t) => (
                <span key={t} className={styles.rulerTick} style={{ left: `${leftPct(t)}%` }}>
                  {t}
                </span>
              ))}
            </div>
          </div>

          <div className={styles.grid}>
            {machineRows.map((row) => (
              <div key={row.name} className={styles.gridRow}>
                <div className={styles.rowLabel}>
                  <span className={styles.rowLabelName}>{row.name}</span>
                  <span className={styles.rowLabelOperator}>{row.operator}</span>
                </div>
                <div className={styles.rowTrack}>
                  <span
                    className={styles.nowLine}
                    style={{ left: `${leftPct("09:35")}%` }}
                  />
                  {row.blocks.map((b, i) => (
                    <div
                      key={i}
                      className={`${styles.block} ${styles[`block_${b.status}`]} ${b.active ? styles.blockActive : ""}`}
                      style={{ left: `${leftPct(b.start)}%`, width: `${widthPct(b.start, b.end)}%` }}
                    >
                      <span className={styles.blockJob}>{b.job}</span>
                      <span className={styles.blockOp}>{b.op}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className={styles.machineStatusRow}>
            <span className={styles.machineStatusLabel}>Machine Status</span>
            {machineRows.map((row) => (
              <div key={row.name} className={styles.machineChip}>
                <span
                  className={`${styles.chipDot} ${
                    row.state === "Active" ? styles.dotActive : row.state === "Idle" ? styles.dotIdle : styles.dotWaiting
                  }`}
                />
                <div>
                  <div className={styles.chipName}>{row.name}</div>
                  <div className={styles.chipState}>{row.state}</div>
                </div>
              </div>
            ))}
          </div>

          <div className={styles.legend}>
            <span><i className={`${styles.swatch} ${styles.block_pending}`} /> Pending</span>
            <span><i className={`${styles.swatch} ${styles.block_active}`} /> Active</span>
            <span><i className={`${styles.swatch} ${styles.block_completed}`} /> Completed</span>
            <span><i className={`${styles.swatch} ${styles.block_delayed}`} /> Delayed</span>
            <span><i className={`${styles.swatch} ${styles.swatchIdle}`} /> (Idle)</span>
          </div>
        </section>

        <aside className={styles.rightPanel}>
          <h2 className={styles.panelTitle}>Job Detail &amp; Simulation Inspector</h2>

          <div className={styles.jobDetailHeader}>
            <div>
              <div className={styles.jobDetailId}>JOB {selectedJob.id}</div>
              <div className={styles.jobDetailTitle}>{selectedJob.title}</div>
            </div>
            <div className={styles.jobDetailBadges}>
              <Badge tone={priorityTone(selectedJob.priority)}>{selectedJob.priority} Priority</Badge>
              <Badge tone="blue">{selectedJob.tab}</Badge>
            </div>
          </div>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Operation Sequence</h3>
            <div className={styles.stepper}>
              {operationSequence.map((s, i) => (
                <div key={s.n} className={styles.stepperItem}>
                  <div className={styles.stepperRow}>
                    <div
                      className={`${styles.stepCircle} ${s.done ? styles.stepDone : ""} ${s.current ? styles.stepCurrent : ""}`}
                    >
                      {s.done ? "✓" : s.n}
                    </div>
                    {i < operationSequence.length - 1 && <div className={styles.stepArrow}>→</div>}
                  </div>
                  <span className={styles.stepLabel}>Op {s.n} {s.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Current Operation Details</h3>
            <dl className={styles.detailList}>
              <div><dt>Operation</dt><dd>Op 2 - Diagnose Issue</dd></div>
              <div><dt>Assigned Machine</dt><dd>Machine B (Chelsea)</dd></div>
              <div><dt>Status</dt><dd><Badge tone="blue">Running</Badge></dd></div>
            </dl>
            <div className={styles.progressRow}>
              <div className={styles.progressTrack}><div className={styles.progressFill} style={{ width: "45%" }} /></div>
              <span className={styles.progressPct}>45%</span>
            </div>
          </div>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Job Metrics</h3>
            <dl className={styles.detailList}>
              <div><dt>Total Estimated Time</dt><dd>4h 30m</dd></div>
              <div><dt>Scheduled Start</dt><dd>09:00 AM</dd></div>
              <div><dt>Scheduled End</dt><dd>01:30 PM</dd></div>
              <div><dt>Current Simulation Time</dt><dd>09:35 AM (35%)</dd></div>
              <div><dt>Earliest Possible End</dt><dd>12:45 PM</dd></div>
              <div><dt>Delay (vs Plan)</dt><dd className={styles.delayValue}>+15m</dd></div>
            </dl>
          </div>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Schedule Modification</h3>
            <label className={styles.fieldLabel}>
              Assign Machine
              <select className={styles.select} defaultValue="Machine B (Chelsea)">
                <option>Machine B (Chelsea)</option>
                <option>Machine A (Anita Sandburg)</option>
                <option>Machine D (George)</option>
              </select>
            </label>
            <label className={styles.fieldLabel}>
              Set Start Time
              <select className={styles.select} defaultValue="09:00 AM">
                <option>09:00 AM</option>
                <option>09:30 AM</option>
                <option>10:00 AM</option>
              </select>
            </label>
            <label className={styles.fieldLabel}>
              Set End Time
              <select className={styles.select} defaultValue="11:00 AM">
                <option>11:00 AM</option>
                <option>11:30 AM</option>
                <option>12:00 PM</option>
              </select>
            </label>
            <button className={styles.confirmBtn}>Confirm &amp; Apply Changes</button>
          </div>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Optimization Log</h3>
            <div className={styles.optLog}>
              <div className={styles.optLogHead}>✓ Optimal route found.</div>
              <p>Saved 3.5 hours compared to manual baseline.</p>
              <div className={styles.optLogFoot}>
                <span>Last optimized: Today, 09:20 AM</span>
                <button className={styles.linkBtn}>View Details</button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <footer className={styles.bottomRow}>
        <div className={styles.alertsPanel}>
          <h3 className={styles.panelTitle}>System Alerts &amp; Notifications</h3>
          <div className={styles.alertsList}>
            {alerts.map((a, i) => (
              <div key={i} className={styles.alertCard}>
                <span className={`${styles.alertDot} ${styles[`alertDot_${a.tone}`]}`} />
                <div className={styles.alertText}>
                  <div className={styles.alertTitle}>{a.title}</div>
                  <div className={styles.alertDetail}>{a.detail}</div>
                </div>
                <button className={styles.linkBtn}>View</button>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.globalActions}>
          <h3 className={styles.panelTitle}>Global Actions &amp; Feedback</h3>
          <p className={styles.globalActionsText}>
            Simulation running at {speed} speed. 6 jobs in progress • 14 pending • 2 delayed
          </p>
          <button className={styles.rescheduleBtn}>
            Reschedule Optimized
            <span>Re-run scheduling algorithm</span>
          </button>
        </div>
      </footer>
    </div>
  );
}
