"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { SEED_JOBS, SEED_MACHINES } from "../_lib/seed";
import type { JobDef, Machine } from "../_lib/types";

/**
 * The job backlog the manager's job builder works on.
 *
 * This lives in memory only — a reload resets it to the seed backlog. It is the
 * seam the API will replace; see the frontend README.
 *
 * It used to hold the generated plan too. It does not any more: generation
 * happens on the backend and the plan is read back from
 * `GET /api/v1/schedules/{id}/timeline`, so the scheduler and simulation pages
 * both draw what is actually stored rather than a copy held here. What is left
 * is the richer local job model — priorities and per-operation durations —
 * that the job builder needs and the API cannot yet
 * express, since there is no operations endpoint to write it through.
 */
interface PlanningValue {
    machines: Machine[];
    jobs: JobDef[];

    createJob: (job: Omit<JobDef, "id">) => string;
    updateJob: (id: string, patch: Partial<Omit<JobDef, "id">>) => void;
    deleteJob: (id: string) => void;
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

    const createJob = useCallback((job: Omit<JobDef, "id">) => {
        const id = nextJobId(jobs);
        setJobs((previous) => [...previous, { ...job, id }]);
        return id;
    }, [jobs]);

    const updateJob = useCallback((id: string, patch: Partial<Omit<JobDef, "id">>) => {
        setJobs((previous) => previous.map((job) => (job.id === id ? { ...job, ...patch } : job)));
    }, []);

    const deleteJob = useCallback((id: string) => {
        setJobs((previous) => previous.filter((job) => job.id !== id));
    }, []);

    const value = useMemo<PlanningValue>(
        () => ({ machines, jobs, createJob, updateJob, deleteJob }),
        [machines, jobs, createJob, updateJob, deleteJob],
    );

    return <PlanningContext.Provider value={value}>{children}</PlanningContext.Provider>;
}

export function usePlanning(): PlanningValue {
    const value = useContext(PlanningContext);
    if (!value) throw new Error("usePlanning must be used inside a PlanningProvider");
    return value;
}
