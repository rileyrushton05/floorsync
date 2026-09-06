"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { generateSchedule } from "../_lib/scheduling";
import { SEED_JOBS, SEED_MACHINES } from "../_lib/seed";
import type { GeneratedSchedule, JobDef, Machine } from "../_lib/types";

/**
 * Planning state shared by the manager routes: the job backlog, which jobs are
 * released, and the schedule generated from them.
 *
 * This lives in memory only — a reload resets it to the seed backlog. It is the
 * seam the API will replace; see the frontend README.
 */
interface PlanningValue {
    machines: Machine[];
    jobs: JobDef[];
    selectedJobIds: string[];
    schedule: GeneratedSchedule | null;
    scheduleErrors: string[];
    /** Job definitions changed since `schedule` was generated. */
    scheduleStale: boolean;

    createJob: (job: Omit<JobDef, "id">) => string;
    updateJob: (id: string, patch: Partial<Omit<JobDef, "id">>) => void;
    deleteJob: (id: string) => void;

    setSelectedJobIds: (ids: string[]) => void;
    toggleJobSelected: (id: string) => void;

    generate: () => void;
    clearSchedule: () => void;
}

const PlanningContext = createContext<PlanningValue | null>(null);

function nextJobId(jobs: JobDef[]): string {
    const highest = jobs.reduce((max, job) => {
        const numeric = Number(job.id.replace(/\D/g, ""));
        return Number.isFinite(numeric) ? Math.max(max, numeric) : max;
    }, 0);
    return `JOB-${highest + 1}`;
}

export function PlanningProvider({ children }: { children: React.ReactNode }) {
    const [machines] = useState<Machine[]>(SEED_MACHINES);
    const [jobs, setJobs] = useState<JobDef[]>(SEED_JOBS);
    const [selectedJobIds, setSelectedJobIds] = useState<string[]>(SEED_JOBS.map((job) => job.id));
    const [schedule, setSchedule] = useState<GeneratedSchedule | null>(null);
    const [scheduleErrors, setScheduleErrors] = useState<string[]>([]);
    const [scheduleStale, setScheduleStale] = useState(false);

    // Any edit to a job definition invalidates a plan built from it. Rather
    // than silently regenerating (which would move blocks under the manager's
    // cursor) the plan is flagged stale and they choose when to rerun it.
    const markStale = useCallback(() => setScheduleStale(true), []);

    const createJob = useCallback((job: Omit<JobDef, "id">) => {
        const id = nextJobId(jobs);
        setJobs((previous) => [...previous, { ...job, id }]);
        setSelectedJobIds((previous) => [...previous, id]);
        markStale();
        return id;
    }, [jobs, markStale]);

    const updateJob = useCallback((id: string, patch: Partial<Omit<JobDef, "id">>) => {
        setJobs((previous) => previous.map((job) => (job.id === id ? { ...job, ...patch } : job)));
        markStale();
    }, [markStale]);

    const deleteJob = useCallback((id: string) => {
        setJobs((previous) =>
            previous
                .filter((job) => job.id !== id)
                // Drop the dangling dependency too, or the backlog is left in a
                // state no selection can satisfy.
                .map((job) => ({ ...job, dependsOn: job.dependsOn.filter((depId) => depId !== id) })),
        );
        setSelectedJobIds((previous) => previous.filter((jobId) => jobId !== id));
        markStale();
    }, [markStale]);

    const toggleJobSelected = useCallback((id: string) => {
        setSelectedJobIds((previous) =>
            previous.includes(id) ? previous.filter((jobId) => jobId !== id) : [...previous, id],
        );
    }, []);

    const generate = useCallback(() => {
        const result = generateSchedule(jobs, machines, selectedJobIds);
        if (result.ok) {
            setSchedule(result.schedule);
            setScheduleErrors([]);
            setScheduleStale(false);
        } else {
            setScheduleErrors(result.errors);
        }
    }, [jobs, machines, selectedJobIds]);

    const clearSchedule = useCallback(() => {
        setSchedule(null);
        setScheduleErrors([]);
        setScheduleStale(false);
    }, []);

    const value = useMemo<PlanningValue>(() => ({
        machines,
        jobs,
        selectedJobIds,
        schedule,
        scheduleErrors,
        scheduleStale,
        createJob,
        updateJob,
        deleteJob,
        setSelectedJobIds,
        toggleJobSelected,
        generate,
        clearSchedule,
    }), [
        machines, jobs, selectedJobIds, schedule, scheduleErrors, scheduleStale,
        createJob, updateJob, deleteJob, toggleJobSelected, generate, clearSchedule,
    ]);

    return <PlanningContext.Provider value={value}>{children}</PlanningContext.Provider>;
}

export function usePlanning(): PlanningValue {
    const value = useContext(PlanningContext);
    if (!value) throw new Error("usePlanning must be used inside a PlanningProvider");
    return value;
}
