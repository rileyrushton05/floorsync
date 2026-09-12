"use client";

import { useAuth } from "@/app/_components/AuthProvider";
import {
    type CursorPage,
    type JobDefinition,
    type JobDefinitionInput,
    type MachineSummary,
    createJobDefinition,
    deleteJob as deletePersistentJob,
    fetchJobDefinitions,
    fetchMachines,
    replaceJobDefinition,
} from "@/app/_lib/api";
import { errorMessage } from "@/app/_lib/load-state";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { JobDef, Machine, OperationDef, OperationRoute, Priority } from "../_lib/types";

export type PlanningLoadState =
    | { status: "loading" }
    | { status: "ready" }
    | { status: "error"; message: string };

/** The manager's API-backed job-definition backlog. */
interface PlanningValue {
    machines: Machine[];
    jobs: JobDef[];
    loadState: PlanningLoadState;
    createJob: (job: Omit<JobDef, "id">) => Promise<JobDef>;
    updateJob: (id: string, job: Omit<JobDef, "id">) => Promise<JobDef>;
    deleteJob: (id: string) => Promise<void>;
}

const PlanningContext = createContext<PlanningValue | null>(null);

const PRIORITY_FROM_API: Record<JobDefinition["priority"], Priority> = {
    high: "High",
    med: "Med",
    low: "Low",
};

const PRIORITY_TO_API: Record<Priority, JobDefinition["priority"]> = {
    High: "high",
    Med: "med",
    Low: "low",
};

function planningRoute(route: JobDefinition["operations"][number]["routes"][number]): OperationRoute {
    return { machineId: route.machine_id, durationMins: route.duration_minutes, energy: route.energy };
}

function planningOperation(operation: JobDefinition["operations"][number]): OperationDef {
    const routes = operation.routes.map(planningRoute);
    const primary = routes[0];
    if (!primary) throw new Error(`The API returned operation ${operation.id} without a machine route.`);
    return {
        id: operation.id,
        name: operation.name,
        machineId: primary.machineId,
        durationMins: primary.durationMins,
        routes,
    };
}

function planningJob(job: JobDefinition): JobDef {
    return {
        id: job.id,
        name: job.name,
        priority: PRIORITY_FROM_API[job.priority],
        operations: [...job.operations]
            .sort((left, right) => left.position - right.position)
            .map(planningOperation),
    };
}

function planningMachine(machine: MachineSummary): Machine {
    return { id: machine.id, name: machine.name, operator: "Unassigned" };
}

/** Preserve non-primary routes when the simplified editor changes its primary route. */
function definitionRoutes(operation: OperationDef): JobDefinitionInput["operations"][number]["routes"] {
    const primary = {
        machine_id: operation.machineId,
        duration_minutes: operation.durationMins,
        energy: operation.routes?.[0]?.energy ?? null,
    };
    const alternatives = (operation.routes ?? [])
        .slice(1)
        .filter((route) => route.machineId !== primary.machine_id)
        .map((route) => ({
            machine_id: route.machineId,
            duration_minutes: route.durationMins,
            energy: route.energy,
        }));
    return [primary, ...alternatives];
}

function definitionInput(job: Omit<JobDef, "id">, retainOperationIds: boolean): JobDefinitionInput {
    return {
        name: job.name,
        priority: PRIORITY_TO_API[job.priority],
        operations: job.operations.map((operation) => ({
            ...(retainOperationIds && !operation.id.startsWith("new-op-") ? { id: operation.id } : {}),
            name: operation.name,
            routes: definitionRoutes(operation),
        })),
    };
}

async function fetchEveryPage<Item>(
    readPage: (cursor?: string) => Promise<CursorPage<Item>>,
): Promise<Item[]> {
    const all: Item[] = [];
    let cursor: string | undefined;
    do {
        const page = await readPage(cursor);
        all.push(...page.items);
        cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return all;
}

export function PlanningProvider({ children }: { children: React.ReactNode }) {
    const { token } = useAuth();
    const [machines, setMachines] = useState<Machine[]>([]);
    const [jobs, setJobs] = useState<JobDef[]>([]);
    const [loadState, setLoadState] = useState<PlanningLoadState>({ status: "loading" });

    useEffect(() => {
        if (token === null) return;
        let current = true;
        setLoadState({ status: "loading" });

        void Promise.all([
            fetchEveryPage((cursor) => fetchJobDefinitions(token, 100, cursor)),
            fetchEveryPage((cursor) => fetchMachines(token, 100, cursor)),
        ])
            .then(([loadedJobs, loadedMachines]) => {
                if (!current) return;
                setJobs(loadedJobs.map(planningJob));
                setMachines(loadedMachines.map(planningMachine));
                setLoadState({ status: "ready" });
            })
            .catch((error: unknown) => {
                if (current) setLoadState({ status: "error", message: errorMessage(error) });
            });

        return () => {
            current = false;
        };
    }, [token]);

    const createJob = useCallback(
        async (job: Omit<JobDef, "id">) => {
            if (token === null) throw new Error("Sign in again before changing the job backlog.");
            const saved = planningJob(await createJobDefinition(definitionInput(job, false), token));
            setJobs((previous) => [...previous, saved]);
            return saved;
        },
        [token],
    );

    const updateJob = useCallback(
        async (id: string, job: Omit<JobDef, "id">) => {
            if (token === null) throw new Error("Sign in again before changing the job backlog.");
            const saved = planningJob(await replaceJobDefinition(id, definitionInput(job, true), token));
            setJobs((previous) => previous.map((existing) => (existing.id === id ? saved : existing)));
            return saved;
        },
        [token],
    );

    const deleteJob = useCallback(
        async (id: string) => {
            if (token === null) throw new Error("Sign in again before changing the job backlog.");
            await deletePersistentJob(id, token);
            setJobs((previous) => previous.filter((job) => job.id !== id));
        },
        [token],
    );

    const value = useMemo<PlanningValue>(
        () => ({ machines, jobs, loadState, createJob, updateJob, deleteJob }),
        [machines, jobs, loadState, createJob, updateJob, deleteJob],
    );

    return <PlanningContext.Provider value={value}>{children}</PlanningContext.Provider>;
}

export function usePlanning(): PlanningValue {
    const value = useContext(PlanningContext);
    if (!value) throw new Error("usePlanning must be used inside a PlanningProvider");
    return value;
}
