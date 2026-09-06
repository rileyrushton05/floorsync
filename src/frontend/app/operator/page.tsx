"use client";

import {
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  PlayIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Note } from "@/components/ui/note";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CoffeeIcon } from "../_components/icons";
import { Wordmark } from "../_components/Logo";

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
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="flex flex-wrap items-center gap-5 border-b bg-navbar px-7 py-3.5">
        <div className="flex items-center gap-2.5">
          <Wordmark />
          <span className="border-l pl-2.5 font-bold text-muted-fg text-xs uppercase tracking-[0.06em]">
            Operator View
          </span>
        </div>
        <Badge intent="outline" className="gap-x-2 px-3 py-1.5">
          <span className="size-2 rounded-full bg-success" />
          {machine.name}
        </Badge>
        <div className="flex-1" />
        <div className="font-semibold tabular-nums">10:24 AM</div>
        <div className="flex items-center gap-2">
          <UserCircleIcon className="size-7 text-muted-fg" />
          <div className="text-sm leading-tight">
            <div className="font-semibold">Operator</div>
            <div className="text-muted-fg text-xs">Shift 1</div>
          </div>
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-5 p-5">
        <div className="grid gap-5 xl:grid-cols-[1fr_1fr_minmax(240px,0.7fr)]">
          <Card className="border-primary/30 bg-primary-subtle/40">
            <CardHeader className="flex-row items-center justify-between gap-3">
              <CardTitle className="font-bold text-primary-subtle-fg text-xs uppercase tracking-[0.06em]">
                Current Operation
              </CardTitle>
              {current && <Badge intent="info">Running</Badge>}
            </CardHeader>
            <CardContent>
              {machine.activeJob && current ? (
                <>
                  <h2 className="font-semibold text-lg">
                    {machine.activeJob.jobId} {machine.activeJob.title}
                  </h2>
                  <div className="mt-1 text-sm">
                    Op {current.index} of {current.total} • {current.name}
                  </div>
                  <div className="mt-1 text-muted-fg text-sm">Started {current.startedAt}</div>
                  <Button className="mt-4 w-full" onPress={completeCurrentOperation}>
                    <CheckIcon /> Mark Complete
                  </Button>
                </>
              ) : (
                <p className="py-4 text-muted-fg text-sm">No active operation on this machine.</p>
              )}
            </CardContent>
          </Card>

          <Card className="border-warning/40 bg-warning-subtle/50">
            <CardHeader className="flex-row items-center justify-between gap-3">
              <CardTitle className="font-bold text-warning-subtle-fg text-xs uppercase tracking-[0.06em]">
                Next Operation
              </CardTitle>
              {nextInfo && <Badge intent="warning">Up Next</Badge>}
            </CardHeader>
            <CardContent>
              {nextInfo ? (
                <>
                  <h2 className="font-semibold text-lg">
                    {nextInfo.jobId}{" "}
                    {machine.activeJob && nextInfo.kind === "same-job"
                      ? machine.activeJob.title
                      : machine.queue.find((q) => q.jobId === nextInfo.jobId)?.title}
                  </h2>
                  <div className="mt-1 text-sm">{nextInfo.label}</div>
                  <div className="mt-1 text-muted-fg text-sm">
                    {nextInfo.estStart
                      ? `Est. Start: ${nextInfo.estStart}`
                      : "Starts immediately after current operation"}
                  </div>
                  <Button
                    intent="outline"
                    className="mt-4 w-full bg-overlay"
                    onPress={
                      nextInfo.kind === "same-job"
                        ? completeCurrentOperation
                        : () => startQueuedJob(nextInfo.jobId)
                    }
                  >
                    <PlayIcon /> Start Next Operation
                  </Button>
                </>
              ) : (
                <p className="py-4 text-muted-fg text-sm">No further operations queued.</p>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-5">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 font-medium text-sm">
                  <ClockIcon className="size-4.5 text-success" />
                  <span>Shift Time Remaining</span>
                </div>
                <div className="mt-2 font-bold text-2xl tabular-nums">
                  {machine.shiftRemaining}{" "}
                  <span className="font-normal text-muted-fg text-sm">of {machine.shiftTotal} hrs</span>
                </div>
                <ProgressBar
                  aria-label="Shift elapsed"
                  value={machine.shiftPct}
                  className="mt-3"
                >
                  <ProgressBarTrack className="min-w-0 [--progress-content-bg:var(--color-success)]" />
                </ProgressBar>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 font-medium text-sm">
                  <CoffeeIcon className="size-4.5 text-primary" />
                  <span>Next Break</span>
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="font-bold text-2xl text-primary tabular-nums">
                    {machine.nextBreakRemaining}
                  </span>
                  <span className="text-muted-fg text-sm">Until {machine.nextBreakAt}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader className="flex-row items-center gap-2.5">
              <CardTitle>Pending Operations</CardTitle>
              <Badge intent="secondary">{machine.queue.length}</Badge>
            </CardHeader>
            <CardContent>
              <Table aria-label="Pending operations">
                <TableHeader>
                  <TableColumn className="w-0">Order</TableColumn>
                  <TableColumn isRowHeader>Job ID</TableColumn>
                  <TableColumn>Operation</TableColumn>
                  <TableColumn>Est. Time</TableColumn>
                  <TableColumn>Est. Start</TableColumn>
                  <TableColumn />
                </TableHeader>
                <TableBody
                  items={machine.queue}
                  renderEmptyState={() => (
                    <div className="py-6 text-center text-muted-fg text-sm">Queue is empty.</div>
                  )}
                >
                  {(q) => {
                    const nextOp = firstPendingOp(q.ops);
                    return (
                      <TableRow id={q.jobId}>
                        <TableCell>
                          <span className="inline-flex size-6 items-center justify-center rounded-full bg-secondary font-semibold text-xs">
                            {machine.queue.indexOf(q) + 1}
                          </span>
                        </TableCell>
                        <TableCell className="font-semibold">{q.jobId}</TableCell>
                        <TableCell>
                          <div className="font-medium">{q.title}</div>
                          <div className="text-muted-fg text-xs">
                            Op {nextOp.index} of {nextOp.total}
                          </div>
                        </TableCell>
                        <TableCell className="tabular-nums">{q.estTime}</TableCell>
                        <TableCell className="tabular-nums">{q.estStart}</TableCell>
                        <TableCell className="text-right">
                          <Button size="xs" onPress={() => startQueuedJob(q.jobId)}>
                            Start
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  }}
                </TableBody>
              </Table>
              <Separator className="my-3" />
              <Button intent="plain" size="sm" className="px-0 text-primary">
                View full queue ({machine.queue.length})
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center gap-2.5">
              <CardTitle>Completed Operations</CardTitle>
              <Badge intent="success">{machine.completed.length}</Badge>
            </CardHeader>
            <CardContent>
              <Table aria-label="Completed operations">
                <TableHeader>
                  <TableColumn isRowHeader>Job ID</TableColumn>
                  <TableColumn>Operation</TableColumn>
                  <TableColumn>Completed At</TableColumn>
                  <TableColumn>Duration</TableColumn>
                </TableHeader>
                <TableBody
                  items={machine.completed}
                  renderEmptyState={() => (
                    <div className="py-6 text-center text-muted-fg text-sm">
                      No completed operations yet.
                    </div>
                  )}
                >
                  {(c) => (
                    <TableRow id={c.key}>
                      <TableCell className="font-semibold">
                        <span className="flex items-center gap-1.5">
                          <CheckCircleIcon className="size-4 text-success" /> {c.jobId}
                        </span>
                      </TableCell>
                      <TableCell>{c.label}</TableCell>
                      <TableCell className="tabular-nums">{c.completedAt}</TableCell>
                      <TableCell className="tabular-nums">{c.duration}</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              <Separator className="my-3" />
              <Button intent="plain" size="sm" className="px-0 text-primary">
                View all completed ({machine.completed.length})
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>

      <footer className="flex flex-wrap items-center gap-4 border-t bg-navbar px-7 py-3.5">
        {issueBanner ? (
          <Note intent="danger" role="status" className="flex-1 py-2">
            <div className="flex items-center gap-3">
              <span className="flex-1">{issueBanner}</span>
              <Button intent="plain" size="xs" onPress={() => setIssueBanner(null)}>
                Dismiss
              </Button>
            </div>
          </Note>
        ) : (
          <div className="flex flex-1 items-center gap-2 text-muted-fg text-sm">
            <InformationCircleIcon className="size-4.5" />
            <span>If you encounter any issues, notify your coordinator.</span>
          </div>
        )}
        <Button intent="danger" onPress={reportIssue}>
          <ExclamationTriangleIcon /> Report Issue
        </Button>
      </footer>
    </div>
  );
}
