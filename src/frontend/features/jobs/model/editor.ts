import { totalWorkMins } from "@/domains/scheduling/format";
import type { JobDef, Machine, OperationDef, Priority } from "@/domains/scheduling/types";

export interface JobDraft {
    id: string | null;
    name: string;
    priority: Priority;
    operations: OperationDef[];
}

export const EMPTY_JOB_DRAFT: JobDraft = { id: null, name: "", priority: "Med", operations: [] };
export const JOB_PRIORITIES: { id: Priority }[] = [{ id: "High" }, { id: "Med" }, { id: "Low" }];
export const DURATION_FILTERS = [
    { id: "All", label: "Any duration" },
    { id: "Short", label: "Short (< 1 hr)" },
    { id: "Medium", label: "Medium (1–4 hrs)" },
    { id: "Long", label: "Long (> 4 hrs)" },
] as const;
export const SORT_OPTIONS = [
    { id: "Manual", label: "Backlog order" },
    { id: "Priority", label: "Priority" },
    { id: "Duration", label: "Total work" },
    { id: "Operations", label: "Number of ops" },
] as const;

const PRIORITY_RANK: Record<Priority, number> = { High: 0, Med: 1, Low: 2 };

export function draftFromJob(job: JobDef): JobDraft {
    return { ...job, operations: job.operations.map((operation) => ({ ...operation, routes: operation.routes?.map((route) => ({ ...route })) })) };
}

export function routesFor(operation: OperationDef): NonNullable<OperationDef["routes"]> {
    return operation.routes?.length
        ? operation.routes
        : [{ machineId: operation.machineId, durationMins: operation.durationMins, energy: null }];
}

export function withRoutes(operation: OperationDef, routes: NonNullable<OperationDef["routes"]>): OperationDef {
    const primary = routes[0];
    return { ...operation, routes, machineId: primary?.machineId ?? "", durationMins: primary?.durationMins ?? 0 };
}

export interface JobFilters {
    query: string;
    priority: Priority | "All";
    machineId: string;
    duration: (typeof DURATION_FILTERS)[number]["id"];
    sort: (typeof SORT_OPTIONS)[number]["id"];
}

export function filterJobs(jobs: JobDef[], filters: JobFilters): JobDef[] {
    const needle = filters.query.trim().toLowerCase();
    const matching = jobs.filter((job) => {
        if (needle && !`${job.id} ${job.name}`.toLowerCase().includes(needle)) return false;
        if (filters.priority !== "All" && job.priority !== filters.priority) return false;
        if (filters.machineId !== "All" && !job.operations.some((operation) => routesFor(operation).some((route) => route.machineId === filters.machineId))) return false;
        const work = totalWorkMins(job);
        return (filters.duration !== "Short" || work < 60) &&
            (filters.duration !== "Medium" || (work >= 60 && work < 240)) &&
            (filters.duration !== "Long" || work >= 240);
    });
    if (filters.sort === "Manual") return matching;
    return [...matching].sort((left, right) => {
        if (filters.sort === "Priority") return PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
        if (filters.sort === "Duration") return totalWorkMins(right) - totalWorkMins(left);
        return right.operations.length - left.operations.length;
    });
}

export function validateJobDraft(draft: JobDraft, machines: Machine[]): string[] {
    const errors: string[] = [];
    if (draft.name.trim() === "") errors.push("Give the job a name.");
    if (draft.operations.length === 0) errors.push("Add at least one operation.");
    draft.operations.forEach((operation, index) => {
        if (operation.name.trim() === "") errors.push(`Operation ${index + 1} needs a name.`);
        const routes = routesFor(operation);
        if (routes.length === 0) errors.push(`Operation ${index + 1} needs at least one machine route.`);
        const seen = new Set<string>();
        routes.forEach((route, routeIndex) => {
            const label = `Operation ${index + 1}, route ${routeIndex + 1}`;
            if (!(route.durationMins > 0)) errors.push(`${label} needs a duration greater than zero.`);
            if (!Number.isInteger(route.durationMins)) errors.push(`${label} needs a whole number of minutes.`);
            if (route.machineId === "") errors.push(`${label} needs a machine.`);
            if (seen.has(route.machineId)) errors.push(`${label} repeats a machine.`);
            seen.add(route.machineId);
            const machine = machines.find((candidate) => candidate.id === route.machineId);
            if (route.machineId !== "" && !machine) errors.push(`${label} uses a machine that no longer exists.`);
            if (machine && !machine.active) errors.push(`${label} uses an inactive machine.`);
            if (route.energy !== null && (!Number.isFinite(Number(route.energy)) || Number(route.energy) < 0)) errors.push(`${label} needs a non-negative energy value.`);
        });
    });
    return errors;
}
