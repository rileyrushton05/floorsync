"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, statusTone } from "../_components/Badge";
import { Wordmark } from "../_components/Logo";
import { SubNav } from "./_components/SubNav";
import {
  IconBell,
  IconBriefcase,
  IconCalendar,
  IconCheckCircle,
  IconChevronDown, IconChevronRight,
  IconClipboard,
  IconClock,
  IconDownload,
  IconGear, IconInfo, IconUser,
  IconUsers,
} from "./icons";
import styles from "./manager.module.css";

interface JobStep { index: number; total: number; name: string; }

interface ManagerJob {
  id: string;
  name: string;
  progress: number;
  status: "In Progress" | "Pending" | "Completed";
  machine: string | null;
  opNames: string[];
  currentOp: (JobStep & { startedAt: string }) | null;
  nextOp: (JobStep & { estStart: string; machine: string }) | null;
}

interface WeekData {
  id: string;
  label: string;
  totalJobs: number;
  completed: number;
  inProgress: number;
  pending: number;
  onTimePct: number;
  delayedJobs: number;
  utilizationPct: number;
  activeOperators: number;
  totalOperators: number;
  machinesRunning: number;
  machinesIdle: number;
  machinesDown: number;
  machinesOffline: number;
  notifications: string[];
  jobs: ManagerJob[];
}

const weeks: WeekData[] = [
  {
    id: "w47",
    label: "Week 47 (Nov 18 - Nov 24)",
    totalJobs: 48,
    completed: 36,
    inProgress: 8,
    pending: 4,
    onTimePct: 96,
    delayedJobs: 4,
    utilizationPct: 87,
    activeOperators: 24,
    totalOperators: 30,
    machinesRunning: 12,
    machinesIdle: 6,
    machinesDown: 2,
    machinesOffline: 10,
    notifications: [
      "Job #256 is delayed by 15 minutes",
      "Machine F reported a fault",
      "3 operators clocked in late",
    ],
    jobs: [
      {
        id: "#254", name: "Dryer not working", progress: 60, status: "In Progress", machine: "Machine B",
        opNames: ["Load Material", "Adjusting Tension", "Quality Check", "Final Test", "Unload & Clean"],
        currentOp: { index: 2, total: 5, name: "Adjusting Tension", startedAt: "09:58 AM" },
        nextOp: { index: 3, total: 5, name: "Quality Check", estStart: "11:02 AM", machine: "Machine B" },
      },
      {
        id: "#255", name: "Washing Machine Issue", progress: 40, status: "In Progress", machine: "Machine A",
        opNames: ["Diagnose Fault", "Replace Belt", "Test Cycle", "Final Inspection"],
        currentOp: { index: 2, total: 4, name: "Replace Belt", startedAt: "09:20 AM" },
        nextOp: { index: 3, total: 4, name: "Test Cycle", estStart: "10:40 AM", machine: "Machine A" },
      },
      {
        id: "#256", name: "Forklift Maintenance", progress: 20, status: "Pending", machine: null,
        opNames: ["Safety Check", "Repair Hydraulics", "Test Drive"],
        currentOp: null,
        nextOp: { index: 1, total: 3, name: "Safety Check", estStart: "11:00 AM", machine: "Machine C" },
      },
      {
        id: "#257", name: "Conveyor Belt Check", progress: 80, status: "In Progress", machine: "Machine D",
        opNames: ["Safety Lockout", "Inspect Rollers", "Lubricate Chain", "Test Run", "Sign Off"],
        currentOp: { index: 4, total: 5, name: "Test Run", startedAt: "09:50 AM" },
        nextOp: { index: 5, total: 5, name: "Sign Off", estStart: "10:30 AM", machine: "Machine D" },
      },
      {
        id: "#258", name: "Tool Replacement", progress: 0, status: "Pending", machine: null,
        opNames: ["Remove Old Tool", "Install New Tool"],
        currentOp: null,
        nextOp: { index: 1, total: 2, name: "Remove Old Tool", estStart: "02:05 PM", machine: "Machine E" },
      },
      {
        id: "#259", name: "Quality Inspection", progress: 100, status: "Completed", machine: "Machine C",
        opNames: ["Prep Samples", "Run Tests", "Record Results"],
        currentOp: null,
        nextOp: null,
      },
      {
        id: "#260", name: "Packaging Line Repair", progress: 0, status: "Pending", machine: null,
        opNames: ["Diagnose", "Replace Part", "Test", "Sign Off"],
        currentOp: null,
        nextOp: { index: 1, total: 4, name: "Diagnose", estStart: "03:00 PM", machine: "Machine F" },
      },
    ],
  },
  {
    id: "w46",
    label: "Week 46 (Nov 11 - Nov 17)",
    totalJobs: 44,
    completed: 39,
    inProgress: 3,
    pending: 2,
    onTimePct: 91,
    delayedJobs: 6,
    utilizationPct: 82,
    activeOperators: 22,
    totalOperators: 30,
    machinesRunning: 10,
    machinesIdle: 8,
    machinesDown: 3,
    machinesOffline: 9,
    notifications: [
      "Job #244 is awaiting parts",
      "Machine C utilization below target",
    ],
    jobs: [
      {
        id: "#240", name: "Dryer Belt Snapped", progress: 100, status: "Completed", machine: "Machine B",
        opNames: ["Diagnose", "Replace Belt", "Test"],
        currentOp: null,
        nextOp: null,
      },
      {
        id: "#241", name: "Oven Door Hinge", progress: 55, status: "In Progress", machine: "Machine A",
        opNames: ["Diagnose", "Replace Hinge", "Test & Close"],
        currentOp: { index: 2, total: 3, name: "Replace Hinge", startedAt: "08:40 AM" },
        nextOp: { index: 3, total: 3, name: "Test & Close", estStart: "09:30 AM", machine: "Machine A" },
      },
      {
        id: "#242", name: "Ice Maker Jam", progress: 100, status: "Completed", machine: "Machine C",
        opNames: ["Diagnose", "Clear Jam", "Test"],
        currentOp: null,
        nextOp: null,
      },
      {
        id: "#243", name: "Dishwasher Pump", progress: 30, status: "In Progress", machine: "Machine D",
        opNames: ["Diagnose Pump", "Replace Pump", "Test Cycle", "Final Check"],
        currentOp: { index: 1, total: 4, name: "Diagnose Pump", startedAt: "09:00 AM" },
        nextOp: { index: 2, total: 4, name: "Replace Pump", estStart: "10:15 AM", machine: "Machine D" },
      },
      {
        id: "#244", name: "Fridge Compressor", progress: 0, status: "Pending", machine: null,
        opNames: ["Diagnose", "Replace Compressor", "Test"],
        currentOp: null,
        nextOp: { index: 1, total: 3, name: "Diagnose", estStart: "01:00 PM", machine: "Machine E" },
      },
      {
        id: "#245", name: "Vent Cleaning", progress: 100, status: "Completed", machine: "Machine F",
        opNames: ["Inspect", "Clean Vent"],
        currentOp: null,
        nextOp: null,
      },
      {
        id: "#246", name: "Panel Rewire", progress: 10, status: "Pending", machine: null,
        opNames: ["Safety Lockout", "Rewire Panel"],
        currentOp: null,
        nextOp: { index: 1, total: 2, name: "Safety Lockout", estStart: "02:30 PM", machine: "Machine C" },
      },
    ],
  },
];

export default function ManagerDashboard() {
  const [weekId, setWeekId] = useState(weeks[0].id);
  const week = useMemo(() => weeks.find((w) => w.id === weekId)!, [weekId]);

  const [selectedJobId, setSelectedJobId] = useState(week.jobs[0].id);
  const [sequenceExpanded, setSequenceExpanded] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [exportedAt, setExportedAt] = useState<string | null>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  const selectedJob = week.jobs.find((j) => j.id === selectedJobId) ?? week.jobs[0];

  // A popover that only closes by clicking its own trigger is a trap on
  // touch and for keyboard users, so dismiss on Escape and outside clicks.
  useEffect(() => {
    if (!notifOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!notifRef.current?.contains(event.target as Node)) setNotifOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNotifOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [notifOpen]);

  function handleWeekChange(id: string) {
    setWeekId(id);
    const newWeek = weeks.find((w) => w.id === id)!;
    setSelectedJobId(newWeek.jobs[0].id);
    setSequenceExpanded(false);
  }

  function handleSelectJob(id: string) {
    setSelectedJobId(id);
    setSequenceExpanded(false);
  }

  const machineTotal = week.machinesRunning + week.machinesIdle + week.machinesDown + week.machinesOffline;
  const completedPct = Math.round((week.completed / week.totalJobs) * 100);
  const inProgressPct = Math.round((week.inProgress / week.totalJobs) * 100);
  const pendingPct = Math.round((week.pending / week.totalJobs) * 100);
  const operatorDots = Array.from({ length: 10 }, (_, i) => i < Math.round((week.activeOperators / week.totalOperators) * 10));

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brandGroup}>
          <Wordmark />
          <span className={styles.viewLabel}>Manager</span>
        </div>

        <SubNav />

        <div className={styles.weekPillWrap}>
          <IconCalendar />
          <select
            className={styles.weekSelect}
            aria-label="Reporting week"
            value={week.id}
            onChange={(e) => handleWeekChange(e.target.value)}
          >
            {weeks.map((w) => (
              <option key={w.id} value={w.id}>{w.label}</option>
            ))}
          </select>
          <IconChevronDown />
        </div>

        <div className={styles.topbarSpacer} />

        <div className={styles.notifWrap} ref={notifRef}>
          <button
            className={styles.bellBtn}
            aria-label={`Notifications (${week.notifications.length})`}
            aria-expanded={notifOpen}
            aria-haspopup="true"
            onClick={() => setNotifOpen((v) => !v)}
          >
            <IconBell />
            {week.notifications.length > 0 && <span className={styles.bellBadge}>{week.notifications.length}</span>}
          </button>
          {notifOpen && (
            <div className={styles.notifDropdown}>
              <div className={styles.notifHead}>Notifications</div>
              {week.notifications.length === 0 && <div className={styles.notifEmpty}>No new notifications.</div>}
              {week.notifications.map((n, i) => (
                <div key={i} className={styles.notifItem}>{n}</div>
              ))}
            </div>
          )}
        </div>

        <button
          className={styles.exportBtn}
          onClick={() => setExportedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}
        >
          <IconDownload /> Export Report
        </button>

        <div className={styles.userBlock}>
          <IconUser />
          <span className={styles.userName}>Manager</span>
        </div>
      </header>

      {exportedAt && (
        <div className={styles.exportToast} role="status">
          Report for {week.label} exported at {exportedAt}.
          <button onClick={() => setExportedAt(null)}>Dismiss</button>
        </div>
      )}

      <main className={styles.main}>
        <div className={styles.statRow}>
          <div className={styles.statCard}>
            <div className={styles.statHead}><IconClipboard /><span>Total Jobs</span></div>
            <div className={styles.statBig}>{week.totalJobs}</div>
            <div className={styles.statLegend}>
              <span><i style={{ background: "#16a34a" }} /> Completed {week.completed} ({completedPct}%)</span>
              <span><i style={{ background: "#2563eb" }} /> In Progress {week.inProgress} ({inProgressPct}%)</span>
              <span><i style={{ background: "#94a3b8" }} /> Pending {week.pending} ({pendingPct}%)</span>
            </div>
          </div>

          <div className={styles.statCard}>
            <div className={styles.statHead}><IconCheckCircle /><span>On-Time Completion</span></div>
            <div className={styles.statBig}>{week.onTimePct}%</div>
            <div className={styles.statSub}>Completed on schedule</div>
            <div className={styles.statDangerRow}>
              <span className={styles.dangerNum}>{week.delayedJobs}</span> Delayed jobs
            </div>
          </div>

          <div className={styles.statCard}>
            <div className={styles.statHead}><IconClock /><span>Machine Utilization</span></div>
            <div className={styles.statBig}>{week.utilizationPct}%</div>
            <div className={styles.statSub}>Average utilization</div>
            <div className={styles.progressTrack}>
              <div className={styles.progressFillAmber} style={{ width: `${week.utilizationPct}%` }} />
            </div>
          </div>

          <div className={styles.statCard}>
            <div className={styles.statHead}><IconUsers /><span>Active Operators</span></div>
            <div className={styles.statBig}>{week.activeOperators} <span className={styles.statBigUnit}>/ {week.totalOperators}</span></div>
            <div className={styles.statSub}>Operators online</div>
            <div className={styles.dotsRow}>
              {operatorDots.map((filled, i) => (
                <span key={i} className={`${styles.opDot} ${filled ? styles.opDotFilled : ""}`} />
              ))}
            </div>
          </div>
        </div>

        <div className={styles.bodyRow}>
          <section className={styles.jobListPanel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Job List</h2>
            </div>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Job Name</th>
                  <th>Progress</th>
                  <th>Status</th>
                  <th>Current Machine</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {week.jobs.map((job) => (
                  <tr
                    key={job.id}
                    className={`${styles.jobRow} ${selectedJobId === job.id ? styles.jobRowActive : ""}`}
                    aria-current={selectedJobId === job.id || undefined}
                    onClick={() => handleSelectJob(job.id)}
                  >
                    <td className={styles.jobIdCell}>{job.id}</td>
                    <td>{job.name}</td>
                    <td>
                      <div className={styles.rowProgress}>
                        <div
                          className={styles.rowProgressTrack}
                          role="progressbar"
                          aria-valuenow={job.progress}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`Job ${job.id} progress`}
                        >
                          <div className={styles.rowProgressFill} style={{ width: `${job.progress}%` }} />
                        </div>
                        <span>{job.progress}%</span>
                      </div>
                    </td>
                    <td><Badge tone={statusTone(job.status)}>{job.status}</Badge></td>
                    <td>{job.machine ?? "–"}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.jobRowBtn}
                        onClick={() => handleSelectJob(job.id)}
                        aria-label={`Show details for job ${job.id}, ${job.name}`}
                      >
                        <IconChevronRight />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Link className={styles.viewAllLink} href="/manager/jobs">
              Manage the job backlog →
            </Link>
          </section>

          <aside className={styles.detailPanel}>
            <div className={styles.detailHead}>
              <div>
                <div className={styles.detailEyebrow}>Job {selectedJob.id}</div>
                <h2 className={styles.detailTitle}>{selectedJob.name}</h2>
              </div>
              <Badge tone={statusTone(selectedJob.status)}>{selectedJob.status}</Badge>
            </div>

            <div className={styles.progressBlock}>
              <div className={styles.progressLabelRow}>
                <span>Progress</span>
                <span className={styles.progressPct}>{selectedJob.progress}%</span>
              </div>
              <div className={styles.progressTrackLg}>
                <div className={styles.progressFillBlue} style={{ width: `${selectedJob.progress}%` }} />
              </div>
            </div>

            <div className={styles.miniCards}>
              <div className={styles.miniCard}>
                <div className={styles.miniCardHead}><IconBriefcase /><span>Currently On</span></div>
                {selectedJob.currentOp && selectedJob.machine ? (
                  <>
                    <div className={styles.miniCardMain}>{selectedJob.machine}</div>
                    <div className={styles.miniCardSub}>Op {selectedJob.currentOp.index} of {selectedJob.currentOp.total} • {selectedJob.currentOp.name}</div>
                    <div className={styles.miniCardMeta}>Started: {selectedJob.currentOp.startedAt}</div>
                  </>
                ) : (
                  <div className={styles.miniCardEmpty}>
                    {selectedJob.status === "Completed" ? "Job complete." : "Not yet started."}
                  </div>
                )}
              </div>

              <div className={styles.miniCard}>
                <div className={styles.miniCardHeadAmber}><IconGear /><span>Next Scheduled Step</span></div>
                {selectedJob.nextOp ? (
                  <>
                    <div className={styles.miniCardMain}>Op {selectedJob.nextOp.index} of {selectedJob.nextOp.total} • {selectedJob.nextOp.name}</div>
                    <div className={styles.miniCardSub}>Est. Start: {selectedJob.nextOp.estStart}</div>
                    <div className={styles.miniCardMeta}>Machine: {selectedJob.nextOp.machine}</div>
                  </>
                ) : (
                  <div className={styles.miniCardEmpty}>No further steps.</div>
                )}
              </div>
            </div>

            <button className={styles.sequenceLink} onClick={() => setSequenceExpanded((v) => !v)}>
              {sequenceExpanded ? "Hide full job sequence" : "View full job sequence"} →
            </button>

            {sequenceExpanded && (
              <ol className={styles.sequenceList}>
                {selectedJob.opNames.map((name, i) => {
                  const idx = i + 1;
                  const state =
                    selectedJob.status === "Completed" ? "done"
                    : selectedJob.currentOp && idx < selectedJob.currentOp.index ? "done"
                    : selectedJob.currentOp && idx === selectedJob.currentOp.index ? "current"
                    : "pending";
                  return (
                    <li key={idx} className={`${styles.sequenceItem} ${styles[`sequence_${state}`]}`}>
                      <span className={styles.sequenceIndex}>{state === "done" ? "✓" : idx}</span>
                      <span>{name}</span>
                    </li>
                  );
                })}
              </ol>
            )}

            <div className={styles.machinesOverview}>
              <h3 className={styles.machinesTitle}>Machines Overview</h3>
              <div className={styles.machinesGrid}>
                <div className={`${styles.machineTile} ${styles.machineTileGreen}`}>
                  <div className={styles.machineTileNum}>{week.machinesRunning}</div>
                  <div className={styles.machineTileLabel}>Running</div>
                </div>
                <div className={`${styles.machineTile} ${styles.machineTileAmber}`}>
                  <div className={styles.machineTileNum}>{week.machinesIdle}</div>
                  <div className={styles.machineTileLabel}>Idle</div>
                </div>
                <div className={`${styles.machineTile} ${styles.machineTileRed}`}>
                  <div className={styles.machineTileNum}>{week.machinesDown}</div>
                  <div className={styles.machineTileLabel}>Down</div>
                </div>
                <div className={`${styles.machineTile} ${styles.machineTileGray}`}>
                  <div className={styles.machineTileNum}>{week.machinesOffline}</div>
                  <div className={styles.machineTileLabel}>Offline</div>
                </div>
              </div>
              <div className={styles.machinesTotal}>{machineTotal} machines total</div>
            </div>
          </aside>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInfo}>
          <IconInfo />
          <span>Click any job to view details or drill into the machine&rsquo;s operator view.</span>
        </div>
        <button className={styles.viewAllMachinesBtn}>View All Machines →</button>
      </footer>
    </div>
  );
}
