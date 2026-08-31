"use client";

import { useMemo, useState } from "react";
import { Wordmark } from "../_components/Logo";
import { Badge } from "../_components/Badge";
import { IconClock, IconCoffee, IconCheck, IconPlay, IconWarning, IconInfo, IconCheckCircle, IconUser } from "./icons";
import styles from "./operator.module.css";

type OpStatus = "completed" | "running" | "pending";

interface OperationStep {
  index: number;
  total: number;
  name: string;
  status: OpStatus;
  startedAt?: string;
}

interface ActiveJob {
  jobId: string;
  title: string;
  ops: OperationStep[];
}

interface QueuedJob {
  jobId: string;
  title: string;
  ops: OperationStep[];
  estTime: string;
  estStart: string;
}

interface CompletedEntry {
  key: string;
  jobId: string;
  label: string;
  completedAt: string;
  duration: string;
}

interface MachineState {
  name: string;
  activeJob: ActiveJob | null;
  queue: QueuedJob[];
  completed: CompletedEntry[];
  shiftRemaining: string;
  shiftTotal: string;
  shiftPct: number;
  nextBreakRemaining: string;
  nextBreakAt: string;
}

function makeOps(names: string[], runningIndex: number, startedAt?: string): OperationStep[] {
  return names.map((name, i) => ({
    index: i + 1,
    total: names.length,
    name,
    status: i < runningIndex ? "completed" : i === runningIndex ? "running" : "pending",
    startedAt: i === runningIndex ? startedAt : undefined,
  }));
}

const initialMachine: MachineState = {
  name: "Machine B",
  activeJob: {
    jobId: "#254",
    title: "Dryer not working",
    ops: makeOps(["Load Material", "Adjusting Tension", "Quality Check", "Final Test", "Unload & Clean"], 1, "09:58 AM"),
  },
  queue: [
    { jobId: "#255", title: "Washing Machine Issue", estTime: "02:00", estStart: "11:02 AM", ops: makeOps(["Diagnose Fault", "Replace Belt", "Test Cycle", "Final Inspection"], -1) },
    { jobId: "#256", title: "Forklift Maintenance", estTime: "01:00", estStart: "01:05 PM", ops: makeOps(["Safety Check", "Repair Hydraulics", "Test Drive"], -1) },
    { jobId: "#258", title: "Tool Replacement", estTime: "02:00", estStart: "02:05 PM", ops: makeOps(["Remove Old Tool", "Install New Tool"], -1) },
  ],
  completed: [
    { key: "c1", jobId: "#254", label: "Op 1 of 5 • Load Material", completedAt: "09:58 AM", duration: "00:12" },
    { key: "c2", jobId: "#253", label: "Op 3 of 3 • Final Test", completedAt: "09:34 AM", duration: "00:18" },
  ],
  shiftRemaining: "03:35",
  shiftTotal: "08:00",
  shiftPct: 55,
  nextBreakRemaining: "00:56",
  nextBreakAt: "10:30 AM",
};

function getCurrentOp(job: ActiveJob | null): OperationStep | null {
  if (!job) return null;
  return job.ops.find((o) => o.status === "running") ?? null;
}

function firstPendingOp(ops: OperationStep[]): OperationStep {
  return ops.find((o) => o.status === "pending") ?? ops[0];
}

export default function OperatorDashboard() {
  const [machine, setMachine] = useState(initialMachine);
  const [issueBanner, setIssueBanner] = useState<string | null>(null);

  const current = useMemo(() => getCurrentOp(machine.activeJob), [machine.activeJob]);

  const nextInfo = useMemo(() => {
    if (machine.activeJob && current) {
      const nextStep = machine.activeJob.ops.find((o) => o.index === current.index + 1);
      if (nextStep) {
        return { kind: "same-job" as const, jobId: machine.activeJob.jobId, label: `Op ${nextStep.index} of ${nextStep.total} • ${nextStep.name}`, estStart: null as string | null };
      }
    }
    if (machine.queue.length > 0) {
      const q = machine.queue[0];
      const next = firstPendingOp(q.ops);
      return { kind: "queued-job" as const, jobId: q.jobId, label: `Op ${next.index} of ${next.total} • ${next.name}`, estStart: q.estStart };
    }
    return null;
  }, [machine, current]);

  function completeCurrentOperation() {
    setMachine((m) => {
      if (!m.activeJob) return m;
      const runningIndex = m.activeJob.ops.findIndex((o) => o.status === "running");
      if (runningIndex === -1) return m;
      const step = m.activeJob.ops[runningIndex];
      const newCompletedEntry: CompletedEntry = {
        key: `${m.activeJob.jobId}-${step.index}-${Date.now()}`,
        jobId: m.activeJob.jobId,
        label: `Op ${step.index} of ${step.total} • ${step.name}`,
        completedAt: "Just now",
        duration: "—",
      };

      let updatedOps = m.activeJob.ops.map((o, i) => (i === runningIndex ? { ...o, status: "completed" as OpStatus } : o));
      let newActiveJob: ActiveJob | null = { ...m.activeJob, ops: updatedOps };
      let newQueue = m.queue;

      if (runningIndex + 1 < updatedOps.length) {
        updatedOps = updatedOps.map((o, i) => (i === runningIndex + 1 ? { ...o, status: "running" as OpStatus, startedAt: "Just now" } : o));
        newActiveJob = { ...m.activeJob, ops: updatedOps };
      } else if (m.queue.length > 0) {
        const [nextJob, ...rest] = m.queue;
        const promotedOps = nextJob.ops.map((o, i) => (i === 0 ? { ...o, status: "running" as OpStatus, startedAt: "Just now" } : o));
        newActiveJob = { jobId: nextJob.jobId, title: nextJob.title, ops: promotedOps };
        newQueue = rest;
      } else {
        newActiveJob = null;
      }

      return {
        ...m,
        activeJob: newActiveJob,
        queue: newQueue,
        completed: [newCompletedEntry, ...m.completed],
      };
    });
  }

  function startQueuedJob(jobId: string) {
    setMachine((m) => {
      const target = m.queue.find((q) => q.jobId === jobId);
      if (!target) return m;

      let newQueue = m.queue.filter((q) => q.jobId !== jobId);

      if (m.activeJob) {
        const runningIndex = m.activeJob.ops.findIndex((o) => o.status === "running");
        if (runningIndex !== -1) {
          const pausedOps = m.activeJob.ops.map((o, i) => (i === runningIndex ? { ...o, status: "pending" as OpStatus, startedAt: undefined } : o));
          const step = pausedOps[runningIndex];
          const pausedJob: QueuedJob = {
            jobId: m.activeJob.jobId,
            title: m.activeJob.title,
            ops: pausedOps,
            estTime: "—",
            estStart: `Paused at Op ${step.index}`,
          };
          newQueue = [pausedJob, ...newQueue];
        }
      }

      const resumeIndex = firstPendingOp(target.ops).index;
      const promotedOps = target.ops.map((o) => (o.index === resumeIndex ? { ...o, status: "running" as OpStatus, startedAt: "Just now" } : o));
      const newActiveJob: ActiveJob = { jobId: target.jobId, title: target.title, ops: promotedOps };

      return {
        ...m,
        activeJob: newActiveJob,
        queue: newQueue,
      };
    });
  }

  function reportIssue() {
    setIssueBanner(`Issue reported for ${machine.name} — coordinator notified.`);
  }

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brandGroup}>
          <Wordmark />
          <span className={styles.viewLabel}>Operator View</span>
        </div>
        <div className={styles.machineTag}>
          <span className={styles.machineDot} />
          {machine.name}
        </div>
        <div className={styles.topbarSpacer} />
        <div className={styles.clock}>10:24 AM</div>
        <div className={styles.userBlock}>
          <IconUser />
          <div>
            <div className={styles.userName}>Operator</div>
            <div className={styles.userShift}>Shift 1</div>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.topRow}>
          <section className={`${styles.card} ${styles.cardBlue}`}>
            <div className={styles.cardHead}>
              <span className={styles.cardLabelBlue}>Current Operation</span>
              {current && <Badge tone="blue">Running</Badge>}
            </div>
            {machine.activeJob && current ? (
              <>
                <h2 className={styles.opTitle}>{machine.activeJob.jobId} {machine.activeJob.title}</h2>
                <div className={styles.opSub}>Op {current.index} of {current.total} • {current.name}</div>
                <div className={styles.opMeta}>Started {current.startedAt}</div>
                <button className={styles.primaryBtn} onClick={completeCurrentOperation}>
                  <IconCheck /> Mark Complete
                </button>
              </>
            ) : (
              <div className={styles.emptyState}>No active operation on this machine.</div>
            )}
          </section>

          <section className={`${styles.card} ${styles.cardAmber}`}>
            <div className={styles.cardHead}>
              <span className={styles.cardLabelAmber}>Next Operation</span>
              {nextInfo && <Badge tone="amber">Up Next</Badge>}
            </div>
            {nextInfo ? (
              <>
                <h2 className={styles.opTitle}>{nextInfo.jobId} {machine.activeJob && nextInfo.kind === "same-job" ? machine.activeJob.title : machine.queue.find((q) => q.jobId === nextInfo.jobId)?.title}</h2>
                <div className={styles.opSub}>{nextInfo.label}</div>
                <div className={styles.opMeta}>{nextInfo.estStart ? `Est. Start: ${nextInfo.estStart}` : "Starts immediately after current operation"}</div>
                <button className={styles.secondaryBtn} onClick={nextInfo.kind === "same-job" ? completeCurrentOperation : () => startQueuedJob(nextInfo.jobId)}>
                  <IconPlay /> Start Next Operation
                </button>
              </>
            ) : (
              <div className={styles.emptyState}>No further operations queued.</div>
            )}
          </section>

          <div className={styles.sideStack}>
            <section className={styles.card}>
              <div className={styles.sideHead}>
                <IconClock />
                <span>Shift Time Remaining</span>
              </div>
              <div className={styles.sideBig}>
                {machine.shiftRemaining} <span className={styles.sideBigUnit}>of {machine.shiftTotal} hrs</span>
              </div>
              <div className={styles.progressTrack}>
                <div className={styles.progressFillGreen} style={{ width: `${machine.shiftPct}%` }} />
              </div>
            </section>
            <section className={styles.card}>
              <div className={styles.sideHead}>
                <IconCoffee />
                <span>Next Break</span>
              </div>
              <div className={styles.sideBigRow}>
                <span className={styles.sideBigPurple}>{machine.nextBreakRemaining}</span>
                <span className={styles.sideBigUnit}>Until {machine.nextBreakAt}</span>
              </div>
            </section>
          </div>
        </div>

        <div className={styles.bottomRow}>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Pending Operations</h2>
              <span className={styles.countPill}>{machine.queue.length}</span>
            </div>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.orderCol}>Order</th>
                  <th>Job ID</th>
                  <th>Operation</th>
                  <th>Est. Time</th>
                  <th>Est. Start</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {machine.queue.map((q, i) => {
                  const nextOp = firstPendingOp(q.ops);
                  return (
                  <tr key={q.jobId}>
                    <td>
                      <span className={styles.orderBadge}>{i + 1}</span>
                    </td>
                    <td className={styles.jobIdCell}>{q.jobId}</td>
                    <td>
                      <div className={styles.opCellTitle}>{q.title}</div>
                      <div className={styles.opCellSub}>Op {nextOp.index} of {nextOp.total}</div>
                    </td>
                    <td>{q.estTime}</td>
                    <td>{q.estStart}</td>
                    <td>
                      <button className={styles.startBtn} onClick={() => startQueuedJob(q.jobId)}>Start</button>
                    </td>
                  </tr>
                  );
                })}
                {machine.queue.length === 0 && (
                  <tr>
                    <td colSpan={6} className={styles.emptyRow}>Queue is empty.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <button className={styles.viewAllLink}>View full queue ({machine.queue.length})</button>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Completed Operations</h2>
              <span className={`${styles.countPill} ${styles.countPillGreen}`}>{machine.completed.length}</span>
            </div>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Operation</th>
                  <th>Completed At</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {machine.completed.map((c) => (
                  <tr key={c.key}>
                    <td className={styles.jobIdCell}>
                      <IconCheckCircle size={16} /> {c.jobId}
                    </td>
                    <td>{c.label}</td>
                    <td>{c.completedAt}</td>
                    <td>{c.duration}</td>
                  </tr>
                ))}
                {machine.completed.length === 0 && (
                  <tr>
                    <td colSpan={4} className={styles.emptyRow}>No completed operations yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <button className={styles.viewAllLink}>View all completed ({machine.completed.length})</button>
          </section>
        </div>
      </main>

      <footer className={styles.footer}>
        {issueBanner ? (
          <div className={styles.issueBanner}>
            <IconWarning size={16} color="#b91c1c" />
            <span>{issueBanner}</span>
            <button className={styles.dismissBtn} onClick={() => setIssueBanner(null)}>Dismiss</button>
          </div>
        ) : (
          <div className={styles.footerInfo}>
            <IconInfo />
            <span>If you encounter any issues, notify your coordinator.</span>
          </div>
        )}
        <button className={styles.reportBtn} onClick={reportIssue}>
          <IconWarning /> Report Issue
        </button>
      </footer>
    </div>
  );
}
