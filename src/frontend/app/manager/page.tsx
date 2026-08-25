"use client";

import { useState } from "react";
import { Wordmark } from "../_components/Logo";
import { Badge, priorityTone, statusTone } from "../_components/Badge";
import { DonutChart } from "../_components/DonutChart";
import { RadialGauge } from "../_components/RadialGauge";
import { UtilizationAreaChart, type UtilizationPoint } from "../_components/AreaChart";
import { IconBars, IconGauge, IconTruck, IconUsers, IconClipboard, IconBell, IconWarning, IconBulb } from "./icons";
import styles from "./manager.module.css";

const navItems = ["Overview", "Production", "Machines", "Jobs", "Operators", "Analytics", "Reports", "Alerts", "Settings"];

const utilizationPoints: UtilizationPoint[] = [
  { label: "08:00 AM", active: 18, capacity: 40 },
  { label: "10:00 AM", active: 34, capacity: 44 },
  { label: "12:00 PM", active: 46, capacity: 48 },
  { label: "02:00 PM", active: 54, capacity: 48 },
  { label: "04:00 PM", active: 40, capacity: 46 },
  { label: "06:00 PM", active: 22, capacity: 40 },
];

const jobTypeSegments = [
  { label: "Assembly", value: 16, color: "#22c55e" },
  { label: "CNC Milling", value: 12, color: "#2563eb" },
  { label: "Quality Check", value: 8, color: "#f59e0b" },
  { label: "Maintenance", value: 6, color: "#7c3aed" },
  { label: "Inspection", value: 4, color: "#ec4899" },
  { label: "Other", value: 2, color: "#94a3b8" },
];

interface CurrentJob {
  id: string;
  priority: "High" | "Normal" | "Low";
  machine: string;
  type: string;
  status: string;
  eta: string;
  progress: number;
}

const currentJobs: CurrentJob[] = [
  { id: "#254", priority: "High", machine: "Machine B", type: "Repair", status: "Running", eta: "02:00 PM", progress: 62 },
  { id: "#255", priority: "Normal", machine: "Machine A", type: "Maintenance", status: "Queued", eta: "01:00 PM", progress: 0 },
  { id: "#256", priority: "High", machine: "Machine D", type: "Repair", status: "Delayed", eta: "03:30 PM", progress: 70 },
  { id: "#257", priority: "Normal", machine: "Machine B", type: "Assembly", status: "Queued", eta: "04:00 PM", progress: 0 },
  { id: "#258", priority: "Low", machine: "Machine C", type: "Inspection", status: "Running", eta: "11:30 AM", progress: 48 },
];

interface Anomaly {
  machine: string;
  issue: string;
  duration: string;
  detected: string;
  actionLabel: string;
  tone: "red" | "amber";
}

const anomalies: Anomaly[] = [
  { machine: "Machine C", issue: "Waiting for Material", duration: "2h 15m", detected: "08:09 AM", actionLabel: "Reschedule", tone: "amber" },
  { machine: "Machine F", issue: "Machine Fault Detected", duration: "0h 45m", detected: "09:39 AM", actionLabel: "Dispatch Tech", tone: "red" },
  { machine: "Machine A", issue: "Maintenance Required", duration: "1h 00m", detected: "09:10 AM", actionLabel: "View Log", tone: "amber" },
  { machine: "Machine D", issue: "Operator Unavailable", duration: "0h 30m", detected: "09:50 AM", actionLabel: "Reassign", tone: "amber" },
  { machine: "Machine E", issue: "Waiting for Approval", duration: "0h 20m", detected: "10:05 AM", actionLabel: "Review", tone: "amber" },
];

export default function ManagerDashboard() {
  const [activeNav, setActiveNav] = useState("Overview");

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brandGroup}>
          <Wordmark />
          <span className={styles.viewLabel}>Manager View</span>
        </div>
        <select className={styles.selectPill} defaultValue="All Locations">
          <option>All Locations</option>
          <option>North Plant</option>
          <option>South Plant</option>
        </select>
        <button className={styles.weekPill}>
          Week 47 (Nov 18 - Nov 24)
          <span className={styles.weekDelta}>↑ 8.6%</span>
        </button>
        <div className={styles.topbarSpacer} />
        <button className={styles.exportBtn}>⬇ Export Report</button>
        <button className={styles.bellBtn} aria-label="Notifications">
          <IconBell />
          <span className={styles.bellBadge}>6</span>
        </button>
        <div className={styles.profile}>
          <span className={styles.avatar}>PM</span>
          <div>
            <div className={styles.profileName}>Plant Manager</div>
          </div>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <nav className={styles.nav}>
            {navItems.map((item) => (
              <button
                key={item}
                className={`${styles.navItem} ${activeNav === item ? styles.navItemActive : ""}`}
                onClick={() => setActiveNav(item)}
              >
                {item}
                {item === "Alerts" && <span className={styles.navBadge}>6</span>}
              </button>
            ))}
          </nav>

          <div className={styles.filters}>
            <div className={styles.filtersHead}>
              <span>FILTERS</span>
              <button className={styles.clearAll}>Clear All</button>
            </div>
            {["Location", "Shift", "Job Type", "Priority"].map((f) => (
              <label key={f} className={styles.filterField}>
                {f}
                <select className={styles.select} defaultValue={`All ${f}s`}>
                  <option>{`All ${f}s`}</option>
                </select>
              </label>
            ))}
          </div>

          <div className={styles.refreshNote}>
            <div>Data refreshed:</div>
            <div className={styles.refreshTime}>10:24 AM, Nov 20, 2024 <span className={styles.liveTag}>Live</span></div>
          </div>
        </aside>

        <main className={styles.main}>
          <div className={styles.statRow}>
            <div className={styles.statCard}>
              <div className={styles.statHead}><IconBars /><span>Production Status</span></div>
              <div className={styles.statBig}>48 <span className={styles.statBigUnit}>Total Jobs</span></div>
              <div className={styles.statSub}>12 Running / Active</div>
              <div className={styles.stackedBar}>
                <span style={{ width: "67%", background: "#2563eb" }} />
                <span style={{ width: "33%", background: "#cbd5e1" }} />
              </div>
              <div className={styles.statLegend}>
                <span><i style={{ background: "#2563eb" }} /> Completed 32 (67%)</span>
                <span><i style={{ background: "#cbd5e1" }} /> Pending 16 (33%)</span>
              </div>
              <button className={styles.statLink}>View all jobs →</button>
            </div>

            <div className={styles.statCard}>
              <div className={styles.statHead}><IconGauge /><span>Efficiency &amp; Downtime</span></div>
              <div className={styles.statDonutRow}>
                <DonutChart
                  size={78}
                  thickness={12}
                  centerTop="87%"
                  segments={[
                    { label: "Utilization", value: 87, color: "#16a34a" },
                    { label: "Downtime", value: 13, color: "#f59e0b" },
                  ]}
                />
                <div className={styles.statLegend}>
                  <span><i style={{ background: "#16a34a" }} /> Utilization 87% (31h 45m)</span>
                  <span><i style={{ background: "#f59e0b" }} /> Downtime 13% (4h 45m)</span>
                </div>
              </div>
              <button className={styles.statLink}>View utilization →</button>
            </div>

            <div className={styles.statCard}>
              <div className={styles.statHead}><IconTruck /><span>On-Time Delivery</span></div>
              <div className={styles.statBig}>96%</div>
              <div className={styles.statSub}>Completed on Schedule</div>
              <div className={styles.statSub}><span className={styles.dangerText}>4</span> Delayed Jobs</div>
              <div className={styles.stackedBar}>
                <span style={{ width: "96%", background: "#7c3aed" }} />
                <span style={{ width: "4%", background: "#fca5a5" }} />
              </div>
              <button className={styles.statLink}>View delays →</button>
            </div>

            <div className={styles.statCard}>
              <div className={styles.statHead}><IconUsers /><span>Active Workforce</span></div>
              <div className={styles.statDonutRow}>
                <div>
                  <div className={styles.statBig}>30 <span className={styles.statBigUnit}>Total Operators</span></div>
                  <div className={styles.statSub}>24 Currently Active</div>
                </div>
                <RadialGauge percent={80} size={64} thickness={8} color="#0891b2" />
              </div>
              <div className={styles.statLegend}>
                <span><i style={{ background: "#0891b2" }} /> Active 24 (80%)</span>
                <span><i style={{ background: "#cbd5e1" }} /> Inactive 6 (20%)</span>
              </div>
              <button className={styles.statLink}>View operators →</button>
            </div>

            <div className={styles.statCard}>
              <div className={styles.statHead}><IconClipboard /><span>Pending Approvals</span></div>
              <div className={styles.statBig}>5 <span className={styles.statBigUnit}>Jobs Awaiting Review</span></div>
              <div className={styles.stackedBar}>
                <span style={{ width: "42%", background: "#f59e0b" }} />
                <span style={{ width: "58%", background: "#cbd5e1" }} />
              </div>
              <div className={styles.statLegend}>
                <span><i style={{ background: "#f59e0b" }} /> Awaiting Review 5 (42%)</span>
                <span><i style={{ background: "#cbd5e1" }} /> Approved 7 (58%)</span>
              </div>
              <button className={styles.statLink}>Review now →</button>
            </div>
          </div>

          <div className={styles.chartRow}>
            <div className={styles.chartCard}>
              <div className={styles.cardHeadRow}>
                <h3 className={styles.cardTitle}>Facility Utilization Over Time</h3>
                <select className={styles.selectSmall} defaultValue="Today">
                  <option>Today</option>
                  <option>This Week</option>
                </select>
              </div>
              <div className={styles.chartLegendRow}>
                <span><i style={{ background: "#2563eb" }} /> Machines Active</span>
                <span><i className={styles.dashedSwatch} /> Capacity (Available)</span>
                <span><i style={{ background: "#fecaca" }} /> Bottleneck (Over Capacity)</span>
              </div>
              <UtilizationAreaChart points={utilizationPoints} bottleneckRange={[2, 4]} markerIndex={3} />
              <div className={styles.bottleneckBar}>
                <IconWarning size={15} />
                <span>Bottleneck detected between 01:30 PM - 03:30 PM</span>
                <button className={styles.statLink}>View bottleneck analysis →</button>
              </div>
            </div>

            <div className={styles.chartCard}>
              <div className={styles.cardHeadRow}>
                <h3 className={styles.cardTitle}>Job Distribution by Type</h3>
                <select className={styles.selectSmall} defaultValue="By Job Type">
                  <option>By Job Type</option>
                  <option>By Machine</option>
                </select>
              </div>
              <div className={styles.donutRow}>
                <DonutChart size={130} thickness={20} centerTop="48" centerBottom="Total Jobs" segments={jobTypeSegments} />
                <div className={styles.donutLegend}>
                  {jobTypeSegments.map((s) => {
                    const total = jobTypeSegments.reduce((a, b) => a + b.value, 0);
                    return (
                      <span key={s.label}>
                        <i style={{ background: s.color }} /> {s.label}
                        <b>{s.value} ({Math.round((s.value / total) * 100)}%)</b>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className={styles.tableRow}>
            <div className={styles.tableCard}>
              <div className={styles.cardHeadRow}>
                <h3 className={styles.cardTitle}>Current Jobs Overview</h3>
                <select className={styles.selectSmall} defaultValue="All Jobs">
                  <option>All Jobs</option>
                </select>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Job ID</th><th>Priority</th><th>Machine</th><th>Job Type</th>
                    <th>Status</th><th>Est. End Time</th><th>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {currentJobs.map((j) => (
                    <tr key={j.id}>
                      <td className={styles.jobIdCell}>{j.id}</td>
                      <td><Badge tone={priorityTone(j.priority)}>{j.priority}</Badge></td>
                      <td>{j.machine}</td>
                      <td>{j.type}</td>
                      <td><Badge tone={statusTone(j.status)}>{j.status}</Badge></td>
                      <td>{j.eta}</td>
                      <td>
                        <div className={styles.rowProgress}>
                          <div className={styles.rowProgressTrack}>
                            <div
                              className={styles.rowProgressFill}
                              style={{ width: `${j.progress}%`, background: j.status === "Delayed" ? "#dc2626" : "#2563eb" }}
                            />
                          </div>
                          <span>{j.progress}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className={styles.statLink}>View all →</button>
            </div>

            <div className={styles.tableCard}>
              <div className={styles.cardHeadRow}>
                <h3 className={styles.cardTitle}>Anomalies &amp; Exceptions</h3>
                <select className={styles.selectSmall} defaultValue="All Types">
                  <option>All Types</option>
                </select>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr><th>Machine</th><th>Issue Type</th><th>Duration</th><th>Detected</th><th>Action</th></tr>
                </thead>
                <tbody>
                  {anomalies.map((a, i) => (
                    <tr key={i}>
                      <td className={styles.jobIdCell}>
                        <span className={`${styles.anomalyDot} ${a.tone === "red" ? styles.dotRed : styles.dotAmber}`} />
                        {a.machine}
                      </td>
                      <td>{a.issue}</td>
                      <td>{a.duration}</td>
                      <td>{a.detected}</td>
                      <td><button className={styles.actionBtn}>{a.actionLabel}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className={styles.statLink}>View all anomalies →</button>
            </div>
          </div>

          <div className={styles.insightBar}>
            <IconBulb />
            <span>
              <b>Insight Summary</b> Overall performance is up 8.6% compared to last week. 2 bottlenecks detected. 4 delayed jobs require attention.
            </span>
            <button className={styles.exportBtn}>View Full Analytics Report →</button>
          </div>
        </main>
      </div>
    </div>
  );
}
