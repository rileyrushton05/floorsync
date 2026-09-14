import { totalWorkMins } from "@/domains/scheduling/format";
import type { JobDef, OperationDef, Priority } from "@/domains/scheduling/types";

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
    return { ...job, operations: job.operations.map((operation) => ({ ...operation, routes: operation.routes.map((route) => ({ ...route })) })) };
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
        if (filters.machineId !== "All" && !job.operations.some((operation) => operation.routes.some((route) => route.machineId === filters.machineId))) return false;
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
