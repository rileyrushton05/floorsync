"use client";

import { useState } from "react";
import { Wordmark } from "../_components/Logo";
import { Badge, priorityTone } from "../_components/Badge";
import { RadialGauge } from "../_components/RadialGauge";
import styles from "./operator.module.css";

type RowPriority = "High" | "Norm" | "Low";

interface QueueRow {
  id: string;
  title: string;
  type: string;
  opProgress: string;
  priority: RowPriority;
  timing: string;
  timingTone: "active" | "queued" | "warning" | "delayed";
  estTime: string;
  plannedEnd: string;
  action: "pause" | "start";
}

const queueRows: QueueRow[] = [
  { id: "#254", title: "Dryer not working", type: "Repair", opProgress: "Op 2 of 5", priority: "High", timing: "Started 2m 16s ago", timingTone: "active", estTime: "04h 00m", plannedEnd: "02:00 PM", action: "pause" },
  { id: "#255", title: "Washing Machine Issue", type: "Repair", opProgress: "Op 1 of 4", priority: "Norm", timing: "Queued for 10:30 AM", timingTone: "queued", estTime: "02h 00m", plannedEnd: "01:00 PM", action: "start" },
  { id: "#256", title: "Forklift Maintenance", type: "Maintenance", opProgress: "Op 1 of 3", priority: "Low", timing: "Queued for 12:00 PM", timingTone: "queued", estTime: "01h 00m", plannedEnd: "03:00 PM", action: "start" },
  { id: "#258", title: "Tool Replacement", type: "Maintenance", opProgress: "Op 1 of 2", priority: "Norm", timing: "Waiting for material", timingTone: "warning", estTime: "02h 00m", plannedEnd: "04:00 PM", action: "start" },
  { id: "#259", title: "Quality Inspection", type: "Inspection", opProgress: "Op 1 of 3", priority: "High", timing: "Delayed", timingTone: "delayed", estTime: "01h 30m", plannedEnd: "05:00 PM", action: "start" },
  { id: "#260", title: "Conveyor Belt Check", type: "Maintenance", opProgress: "Op 1 of 2", priority: "Norm", timing: "Queued for 02:00 PM", timingTone: "queued", estTime: "01h 00m", plannedEnd: "05:30 PM", action: "start" },
];

interface OperationStep {
  n: number;
  name: string;
  state: "done" | "running" | "pending";
  detail: string;
  timer?: string;
}

const operations: OperationStep[] = [
  { n: 1, name: "Load Material", state: "done", detail: "09:58 AM - 10:00 AM" },
  { n: 2, name: "Adjusting Tension", state: "running", detail: "Started 2m 16s ago", timer: "02:16" },
  { n: 3, name: "Quality Check", state: "pending", detail: "Est. 45m" },
  { n: 4, name: "Final Test", state: "pending", detail: "Est. 30m" },
  { n: 5, name: "Unload & Clean", state: "pending", detail: "Est. 25m" },
];

const statusFilters = [
  { label: "Running", count: 1, checked: true },
  { label: "Queued", count: 15, checked: true },
  { label: "Paused", count: 0, checked: false },
  { label: "Complete", count: 23, checked: false },
  { label: "Delayed", count: 2, checked: true },
];
const priorityFilters = [
  { label: "High", checked: true },
  { label: "Normal", checked: true },
  { label: "Low", checked: false },
];
const jobTypeFilters = [
  { label: "Repair", checked: true },
  { label: "Maintenance", checked: true },
  { label: "Assembly", checked: false },
  { label: "Inspection", checked: false },
];

export default function OperatorDashboard() {
  const [selectedId, setSelectedId] = useState("#254");
  const [tab, setTab] = useState<"operations" | "notes">("operations");
  const selected = queueRows.find((r) => r.id === selectedId) ?? queueRows[0];

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Wordmark />
        <select className={styles.machineSelect} defaultValue="Machine B: Anita Sandburg">
          <option>Machine B: Anita Sandburg</option>
          <option>Machine A: Chelsea</option>
          <option>Machine C: Fiona</option>
        </select>
        <div className={styles.clock}>
          <span className={styles.clockLabel}>Live Clock:</span> 10:24 AM
        </div>
        <span className={styles.liveBadge}><span className={styles.liveDot} /> Live (Simulation)</span>
        <div className={styles.topbarSpacer} />
        <div className={styles.userBlock}>
          Logged in: <b>J. Smith (Shift 1)</b>
        </div>
        <button className={styles.logoutBtn}>Logout</button>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <h2 className={styles.panelTitle}>Filters &amp; Search</h2>
          <input className={styles.searchInput} placeholder="Search current queue..." />

          <div className={styles.filterGroup}>
            <span className={styles.filterGroupLabel}>Status</span>
            {statusFilters.map((f) => (
              <label key={f.label} className={styles.checkRow}>
                <input type="checkbox" defaultChecked={f.checked} />
                {f.label}
                <span className={styles.checkCount}>{f.count}</span>
              </label>
            ))}
          </div>

          <div className={styles.filterGroup}>
            <span className={styles.filterGroupLabel}>Priority</span>
            {priorityFilters.map((f) => (
              <label key={f.label} className={styles.checkRow}>
                <input type="checkbox" defaultChecked={f.checked} />
                {f.label}
              </label>
            ))}
          </div>

          <div className={styles.filterGroup}>
            <span className={styles.filterGroupLabel}>Job Type</span>
            {jobTypeFilters.map((f) => (
              <label key={f.label} className={styles.checkRow}>
                <input type="checkbox" defaultChecked={f.checked} />
                {f.label}
              </label>
            ))}
          </div>

          <div className={styles.filterGroup}>
            <span className={styles.filterGroupLabel}>Date</span>
            <label className={styles.checkRow}><input type="radio" name="date" defaultChecked /> Today</label>
            <label className={styles.checkRow}><input type="radio" name="date" /> This Shift</label>
            <label className={styles.checkRow}><input type="radio" name="date" /> Custom Range</label>
            <input className={styles.dateInput} placeholder="Select dates..." disabled />
          </div>

          <button className={styles.clearBtn}>Clear All Filters</button>
        </aside>

        <main className={styles.main}>
          <div className={styles.statRow}>
            <div className={`${styles.statCard} ${styles.statCardGreen}`}>
              <div className={styles.statTop}>RUNNING <span className={styles.dotGreen} /></div>
              <div className={styles.statBig}>1</div>
              <div className={styles.statSub}>Currently in progress</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statTop}>QUEUE</div>
              <div className={styles.statBig}>15</div>
              <div className={styles.statSub}>Upcoming jobs</div>
            </div>
            <div className={`${styles.statCard} ${styles.statCardAmber}`}>
              <div className={styles.statTop}>EST. TIME LEFT</div>
              <div className={styles.statBig}>2h 30m</div>
              <div className={styles.statSub}>For current operation</div>
            </div>
            <div className={`${styles.statCard} ${styles.statCardPurple}`}>
              <div className={styles.statTopRow}>
                <div>
                  <div className={styles.statTop}>EFFICIENCY</div>
                  <div className={styles.statBig}>95%</div>
                  <div className={styles.statSub}>vs. planned schedule</div>
                </div>
                <RadialGauge percent={95} size={54} thickness={7} color="#7c3aed" />
              </div>
            </div>
          </div>

          <div className={styles.queuePanel}>
            <div className={styles.queueHead}>
              <h2 className={styles.panelTitle}>Job Queue for Machine B</h2>
              <div className={styles.queueHeadRight}>
                <span className={styles.sortLabel}>Sort by:</span>
                <select className={styles.select} defaultValue="Planned Start Time">
                  <option>Planned Start Time</option>
                  <option>Priority</option>
                </select>
              </div>
            </div>

            <div className={styles.queueList}>
              {queueRows.map((row) => (
                <div
                  key={row.id}
                  className={`${styles.queueRow} ${styles[`queueRow_${row.timingTone}`]} ${
                    selectedId === row.id ? styles.queueRowSelected : ""
                  }`}
                  onClick={() => setSelectedId(row.id)}
                >
                  <span className={styles.chevron}>{selectedId === row.id ? "▾" : "▸"}</span>
                  <div className={styles.queueMain}>
                    <div className={styles.queueTitleRow}>
                      <span className={styles.queueId}>{row.id}</span>
                      <span className={styles.queueTitle}>{row.title}</span>
                    </div>
                    <div className={styles.queueSub}>{row.type} • {row.opProgress}</div>
                  </div>
                  <Badge tone={priorityTone(row.priority)}>{row.priority}</Badge>
                  {row.action === "pause" ? (
                    <button className={styles.pauseBtn} onClick={(e) => e.stopPropagation()}>❚❚ Pause</button>
                  ) : (
                    <button className={styles.startBtn} onClick={(e) => e.stopPropagation()}>▶ Start Now</button>
                  )}
                  <div className={styles.queueTiming}>
                    <span className={`${styles.timingDot} ${styles[`timingDot_${row.timingTone}`]}`} />
                    {row.timing}
                    {row.timingTone === "warning" && <span className={styles.warnMark}>⚠</span>}
                    {row.timingTone === "delayed" && <span className={styles.warnMark}>!</span>}
                  </div>
                  <div className={styles.queueMeta}>
                    <div>Est. Time: <b>{row.estTime}</b></div>
                    <div>Planned End: <b>{row.plannedEnd}</b></div>
                  </div>
                </div>
              ))}
            </div>

            <div className={styles.pagination}>
              <span>Showing 6 of 15 queued jobs</span>
              <div className={styles.pageButtons}>
                <button className={`${styles.pageBtn} ${styles.pageBtnActive}`}>1</button>
                <button className={styles.pageBtn}>2</button>
                <button className={styles.pageBtn}>3</button>
                <button className={styles.pageBtn}>›</button>
              </div>
            </div>
          </div>

          <div className={styles.machineBar}>
            <div>
              <div className={styles.machineBarLabel}>Machine B Status</div>
              <div className={styles.machineBarValue}><span className={styles.dotGreen} /> Active</div>
            </div>
            <div>
              <div className={styles.machineBarLabel}>Current Operation</div>
              <div className={styles.machineBarValue}>#254 Dryer not working • Op 2 of 5</div>
            </div>
            <div>
              <div className={styles.machineBarLabel}>Machine Health</div>
              <div className={styles.machineBarValue}>✓ Good</div>
            </div>
            <div>
              <div className={styles.machineBarLabel}>Last Maintenance</div>
              <div className={styles.machineBarValue}>2 days ago</div>
            </div>
            <button className={styles.historyLink}>View Machine History →</button>
          </div>
        </main>

        <aside className={styles.detailPanel}>
          <div className={styles.detailHead}>
            <h2 className={styles.panelTitle}>Job Details</h2>
            <button className={styles.closeBtn} aria-label="Close">✕</button>
          </div>
          <div className={styles.detailTitleRow}>
            <span className={styles.detailId}>{selected.id}</span>
            <span className={styles.detailTitle}>{selected.title}</span>
          </div>
          <div className={styles.detailBadges}>
            <Badge tone={priorityTone(selected.priority)}>{selected.priority}</Badge>
            <Badge tone="blue">Running</Badge>
            <span className={styles.detailStep}>{selected.opProgress}</span>
          </div>

          <div className={styles.detailTabs}>
            <button className={`${styles.detailTab} ${tab === "operations" ? styles.detailTabActive : ""}`} onClick={() => setTab("operations")}>
              Operations
            </button>
            <button className={`${styles.detailTab} ${tab === "notes" ? styles.detailTabActive : ""}`} onClick={() => setTab("notes")}>
              Details &amp; Notes
            </button>
          </div>

          {tab === "operations" ? (
            <div className={styles.opsList}>
              {operations.map((op) => (
                <div key={op.n} className={styles.opRow}>
                  <span className={`${styles.opIcon} ${styles[`opIcon_${op.state}`]}`}>
                    {op.state === "done" ? "✓" : op.n}
                  </span>
                  <div className={styles.opInfo}>
                    <div className={styles.opName}>Op {op.n}: {op.name}</div>
                    <div className={styles.opDetail}>{op.detail}</div>
                  </div>
                  {op.state === "running" && <span className={styles.opTimer}>⏱ {op.timer}</span>}
                  {op.state === "running" && <Badge tone="blue">Running</Badge>}
                  {op.state === "pending" && <Badge tone="gray">Pending</Badge>}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.notesBlock}>
              <p>Please ensure tension is set to specification 12.5±0.5 before proceeding to quality check.</p>
              <p>Refer to Work Instruction WI-254-A.</p>
              <div className={styles.notesFooter}>Added by: Coordinator A. Lee, Today, 09:45 AM</div>
            </div>
          )}

          <button className={styles.reportBtn}>⚠ Report Issue / Machine Fault</button>
        </aside>
      </div>
    </div>
  );
}
