"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeader,
  CalendarNavButton,
  CalendarTitle,
  CalendarWeekdayHeader,
} from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import {
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  ArrowDownTrayIcon,
  BellIcon,
  BriefcaseIcon,
  CalendarIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  ClipboardDocumentListIcon,
  ClockIcon,
  Cog6ToothIcon,
  InformationCircleIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { getLocalTimeZone, parseDate, today, type CalendarDate } from "@internationalized/date";
import { useMemo, useState } from "react";
import type { Key } from "react-aria-components";
import type { DateValue } from "react-aria-components/Calendar";
import { toast } from "sonner";
import { statusIntent } from "../_lib/badge-intent";
import { ManagerTopbar } from "./_components/ManagerTopbar";

interface JobStep { index: number; total: number; name: string; }

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatShortDate(date: Date): string {
  return `${WEEKDAY_SHORT[date.getDay()]}, ${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`;
}

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

const MACHINE_TILES = [
  { key: "machinesRunning", label: "Running", className: "border-success/30 bg-success-subtle text-success-subtle-fg" },
  { key: "machinesIdle", label: "Idle", className: "border-warning/30 bg-warning-subtle text-warning-subtle-fg" },
  { key: "machinesDown", label: "Down", className: "border-danger/30 bg-danger-subtle text-danger-subtle-fg" },
  { key: "machinesOffline", label: "Offline", className: "border-border bg-muted text-muted-fg" },
] as const;

export default function ManagerDashboard() {
  const [selectedDate, setSelectedDate] = useState(() => today(getLocalTimeZone()));
  const [viewMode, setViewMode] = useState<Key | null>("day");
  const isDayView = viewMode === "day";

  // The seeded data is weekly; the calendar picks the reporting date and the
  // week bucket is derived from which seeded range it falls in.
  const weekId = useMemo(() => weekIdForDate(selectedDate), [selectedDate]);
  const week = useMemo(() => weeks.find((w) => w.id === weekId) ?? weeks[0], [weekId]);

  const [selectedJobId, setSelectedJobId] = useState(week.jobs[0].id);
  const [sequenceExpanded, setSequenceExpanded] = useState(false);

  const selectedJob = week.jobs.find((j) => j.id === selectedJobId) ?? week.jobs[0];

  // In day view the job list narrows to the slice of the week's jobs assigned
  // to the selected weekday, so the daily numbers stay consistent with the
  // week totals. Falls back to the full list when a weekday has no jobs.
  const dayJobs = useMemo(() => {
    const offset = (selectedDate.toDate(getLocalTimeZone()).getDay() + 6) % 7; // Monday = 0
    const slice = week.jobs.filter((_, i) => i % 7 === offset);
    return slice.length > 0 ? slice : week.jobs;
  }, [selectedDate, week.jobs]);
  const visibleJobs = isDayView ? dayJobs : week.jobs;

  function weekIdForDate(date: DateValue) {
    const iso = date.toString();
    if (iso >= "2025-11-11" && iso <= "2025-11-17") return "w46";
    return "w47";
  }

  function handleDateChange(date: DateValue) {
    setSelectedDate(date as CalendarDate);
    const newWeek = weeks.find((w) => w.id === weekIdForDate(date)) ?? weeks[0];
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
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <ManagerTopbar>
        <ToggleGroup
          aria-label="Overview granularity"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([isDayView ? "day" : "week"])}
          onSelectionChange={(keys) => {
            const [first] = Array.from(keys);
            if (typeof first === "string") setViewMode(first);
          }}
        >
          <ToggleGroupItem id="day" aria-label="Daily view">Day</ToggleGroupItem>
          <ToggleGroupItem id="week" aria-label="Weekly view">Week</ToggleGroupItem>
        </ToggleGroup>

        <Popover>
          <Button intent="outline" size="sm" aria-label="Pick reporting date">
            <CalendarIcon />
            {formatShortDate(selectedDate.toDate(getLocalTimeZone()))}
          </Button>
          <PopoverContent className="sm:max-w-none">
            <Calendar
              aria-label="Reporting date"
              value={selectedDate}
              onChange={handleDateChange}
              minValue={parseDate("2025-11-11")}
              maxValue={parseDate("2025-11-24")}
            >
              <CalendarHeader>
                <CalendarNavButton slot="previous" aria-label="Previous month">
                  <ChevronRightIcon className="size-4 rotate-180" />
                </CalendarNavButton>
                <CalendarTitle />
                <CalendarNavButton slot="next" aria-label="Next month">
                  <ChevronRightIcon className="size-4" />
                </CalendarNavButton>
              </CalendarHeader>
              <CalendarGrid>
                <CalendarGridHeader>
                  {(date) => <CalendarWeekdayHeader />}
                </CalendarGridHeader>
                <CalendarGridBody>
                  {(date) => (
                    <CalendarCell date={date}>{date.day}</CalendarCell>
                  )}
                </CalendarGridBody>
              </CalendarGrid>
            </Calendar>
          </PopoverContent>
        </Popover>

        <span className="min-w-[220px] font-medium text-muted-fg text-sm text-center">
          {isDayView
            ? `${week.label.replace(/\s*\(.*\)/, '')} · ${formatShortDate(selectedDate.toDate(getLocalTimeZone()))}`
            : week.label}
        </span>

        <div className="flex-1" />

        {/* React Aria's Popover owns dismissal — Escape, outside clicks and
            focus restoration all come for free, so the hand-rolled document
            listeners this page used to carry are gone. */}
        <Popover>
          <Button
            intent="outline"
            size="sq-sm"
            className="relative"
            aria-label={`Notifications (${week.notifications.length})`}
          >
            <BellIcon />
            {week.notifications.length > 0 && (
              <span className="-top-1.5 -right-1.5 absolute flex size-4.5 items-center justify-center rounded-full bg-danger font-bold text-[10px] text-danger-fg">
                {week.notifications.length}
              </span>
            )}
          </Button>
          <PopoverContent className="sm:max-w-xs">
            <PopoverHeader>
              <PopoverTitle>Notifications</PopoverTitle>
            </PopoverHeader>
            <PopoverBody className="pb-4">
              {week.notifications.length === 0 ? (
                <p className="text-muted-fg text-sm">No new notifications.</p>
              ) : (
                <ul className="divide-y">
                  {week.notifications.map((n) => (
                    <li key={n} className="py-2.5 text-sm first:pt-0 last:pb-0">
                      {n}
                    </li>
                  ))}
                </ul>
              )}
            </PopoverBody>
          </PopoverContent>
        </Popover>

        <Button
          intent="outline"
          onPress={() =>
            toast.success(
              `Report for ${week.label} exported at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`,
            )
          }
        >
          <ArrowDownTrayIcon /> Export Report
        </Button>
      </ManagerTopbar>

      <main className="flex flex-1 flex-col gap-5 p-5">
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 font-medium text-muted-fg text-sm">
                <ClipboardDocumentListIcon className="size-4.5" />
                <span>Total Jobs</span>
              </div>
              <div className="mt-2 font-bold text-3xl tabular-nums">{week.totalJobs}</div>
              <ul className="mt-3 space-y-1 text-xs">
                <li className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-success" />
                  Completed {week.completed} ({completedPct}%)
                </li>
                <li className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-primary" />
                  In Progress {week.inProgress} ({inProgressPct}%)
                </li>
                <li className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-muted-fg" />
                  Pending {week.pending} ({pendingPct}%)
                </li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 font-medium text-muted-fg text-sm">
                <CheckCircleIcon className="size-4.5" />
                <span>On-Time Completion</span>
              </div>
              <div className="mt-2 font-bold text-3xl tabular-nums">{week.onTimePct}%</div>
              <div className="text-muted-fg text-sm">Completed on schedule</div>
              <div className="mt-3 flex items-center gap-2 text-sm">
                <span className="font-bold text-danger text-lg tabular-nums">{week.delayedJobs}</span>
                <span className="text-muted-fg">Delayed jobs</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 font-medium text-muted-fg text-sm">
                <ClockIcon className="size-4.5" />
                <span>Machine Utilization</span>
              </div>
              <div className="mt-2 font-bold text-3xl tabular-nums">{week.utilizationPct}%</div>
              <div className="text-muted-fg text-sm">Average utilization</div>
              <ProgressBar
                aria-label="Average machine utilization"
                value={week.utilizationPct}
                className="mt-3"
              >
                <ProgressBarTrack className="min-w-0 [--progress-content-bg:var(--color-warning)]" />
              </ProgressBar>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 font-medium text-muted-fg text-sm">
                <UsersIcon className="size-4.5" />
                <span>Active Operators</span>
              </div>
              <div className="mt-2 font-bold text-3xl tabular-nums">
                {week.activeOperators}{" "}
                <span className="font-normal text-base text-muted-fg">/ {week.totalOperators}</span>
              </div>
              <div className="text-muted-fg text-sm">Operators online</div>
              <div className="mt-3 flex gap-1">
                {operatorDots.map((filled, i) => (
                  <span
                    key={i}
                    className={`h-2 flex-1 rounded-full ${filled ? "bg-primary" : "bg-secondary"}`}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>{isDayView ? "Today's Jobs" : "Job List"}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table
                aria-label="Job list"
                selectionMode="single"
                selectionBehavior="replace"
                selectedKeys={new Set([selectedJobId])}
                onSelectionChange={(keys) => {
                  if (keys === "all") return;
                  const [first] = Array.from(keys);
                  if (typeof first === "string") handleSelectJob(first);
                }}
              >
                <TableHeader>
                  <TableColumn isRowHeader>Job ID</TableColumn>
                  <TableColumn>Job Name</TableColumn>
                  <TableColumn>Progress</TableColumn>
                  <TableColumn>Status</TableColumn>
                  <TableColumn>Current Machine</TableColumn>
                  <TableColumn />
                </TableHeader>
                <TableBody items={visibleJobs}>
                  {(job) => (
                    <TableRow id={job.id}>
                      <TableCell className="font-semibold">{job.id}</TableCell>
                      <TableCell>{job.name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <ProgressBar
                            aria-label={`Job ${job.id} progress`}
                            value={job.progress}
                            className="w-24"
                          >
                            <ProgressBarTrack className="min-w-0" />
                          </ProgressBar>
                          <span className="text-xs tabular-nums">{job.progress}%</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge intent={statusIntent(job.status)}>{job.status}</Badge>
                      </TableCell>
                      <TableCell>{job.machine ?? "–"}</TableCell>
                      <TableCell className="text-right">
                        <Link
                          href="/manager/jobs"
                          aria-label={`Open ${job.id} details`}
                          className="inline-flex items-center text-muted-fg transition hover:text-primary"
                        >
                          <ChevronRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              <Separator className="my-3" />
              <Link href="/manager/jobs" className="text-primary text-sm">
                Manage the job backlog →
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <div className="font-medium text-muted-fg text-xs uppercase tracking-[0.06em]">
                  {isDayView
                    ? selectedDate.toDate(getLocalTimeZone()).toLocaleDateString('en-AU', {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    })
                    : week.label}
                </div>
                <CardTitle className="mt-1">Job {selectedJob.id} — {selectedJob.name}</CardTitle>
              </div>
              <Badge intent={statusIntent(selectedJob.status)}>{selectedJob.status}</Badge>
            </CardHeader>
            <CardContent className="space-y-5">
              <ProgressBar aria-label="Job progress" value={selectedJob.progress}>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted-fg">Progress</span>
                  <span className="font-semibold tabular-nums">{selectedJob.progress}%</span>
                </div>
                <ProgressBarTrack className="h-2.5 min-w-0" />
              </ProgressBar>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border bg-muted p-3">
                  <div className="flex items-center gap-2 font-medium text-primary text-xs">
                    <BriefcaseIcon className="size-4" />
                    <span>Currently On</span>
                  </div>
                  {selectedJob.currentOp && selectedJob.machine ? (
                    <>
                      <div className="mt-1.5 font-semibold text-sm">{selectedJob.machine}</div>
                      <div className="text-muted-fg text-xs">
                        Op {selectedJob.currentOp.index} of {selectedJob.currentOp.total} •{" "}
                        {selectedJob.currentOp.name}
                      </div>
                      <div className="mt-1 text-muted-fg text-xs">
                        Started: {selectedJob.currentOp.startedAt}
                      </div>
                    </>
                  ) : (
                    <div className="mt-1.5 text-muted-fg text-xs">
                      {selectedJob.status === "Completed" ? "Job complete." : "Not yet started."}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border bg-muted p-3">
                  <div className="flex items-center gap-2 font-medium text-warning-subtle-fg text-xs">
                    <Cog6ToothIcon className="size-4" />
                    <span>Next Scheduled Step</span>
                  </div>
                  {selectedJob.nextOp ? (
                    <>
                      <div className="mt-1.5 font-semibold text-sm">
                        Op {selectedJob.nextOp.index} of {selectedJob.nextOp.total} •{" "}
                        {selectedJob.nextOp.name}
                      </div>
                      <div className="text-muted-fg text-xs">
                        Est. Start: {selectedJob.nextOp.estStart}
                      </div>
                      <div className="mt-1 text-muted-fg text-xs">
                        Machine: {selectedJob.nextOp.machine}
                      </div>
                    </>
                  ) : (
                    <div className="mt-1.5 text-muted-fg text-xs">No further steps.</div>
                  )}
                </div>
              </div>

              <Button
                intent="plain"
                size="sm"
                className="px-0 text-primary"
                onPress={() => setSequenceExpanded((v) => !v)}
              >
                {sequenceExpanded ? "Hide full job sequence" : "View full job sequence"} →
              </Button>

              {sequenceExpanded && (
                <ol className="space-y-1.5">
                  {selectedJob.opNames.map((name, i) => {
                    const idx = i + 1;
                    const state =
                      selectedJob.status === "Completed" ? "done"
                        : selectedJob.currentOp && idx < selectedJob.currentOp.index ? "done"
                          : selectedJob.currentOp && idx === selectedJob.currentOp.index ? "current"
                            : "pending";
                    return (
                      <li key={idx} className="flex items-center gap-2.5 text-sm">
                        <span
                          className={`flex size-6 shrink-0 items-center justify-center rounded-full font-semibold text-xs ${state === "done"
                            ? "bg-success text-success-fg"
                            : state === "current"
                              ? "bg-primary text-primary-fg"
                              : "bg-secondary text-secondary-fg"
                            }`}
                        >
                          {state === "done" ? "✓" : idx}
                        </span>
                        <span className={state === "pending" ? "text-muted-fg" : undefined}>{name}</span>
                      </li>
                    );
                  })}
                </ol>
              )}

              <div>
                <h3 className="font-semibold text-sm">Machines Overview</h3>
                <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {MACHINE_TILES.map((tile) => (
                    <div key={tile.key} className={`rounded-lg border p-3 text-center ${tile.className}`}>
                      <div className="font-bold text-xl tabular-nums">{week[tile.key]}</div>
                      <div className="text-xs">{tile.label}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-muted-fg text-xs">{machineTotal} machines total</div>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      <footer className="flex flex-wrap items-center gap-4 border-t bg-navbar px-7 py-3.5">
        <div className="flex flex-1 items-center gap-2 text-muted-fg text-sm">
          <InformationCircleIcon className="size-4.5" />
          <span>Click any job to view details or drill into the machine&rsquo;s operator view.</span>
        </div>
        <Button intent="outline">View All Machines →</Button>
      </footer>
    </div>
  );
}
