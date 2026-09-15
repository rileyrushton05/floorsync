import { stableJobOrder } from "@/domains/scheduling/colors";
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

/**
 * How the backlog can be ordered.
 *
 * There is deliberately no "backlog order" option. The API returns jobs sorted
 * by `(name, id)`, which is an artefact of how the page is fetched rather than
 * an order a manager chose — offering it as a sort implied the backlog had a
 * running order that someone could act on, and it does not. Priority is the
 * one that answers "what should be looked at first", so it leads and is the
 * default.
 */
export const SORT_OPTIONS = [
    { id: "Priority", label: "Priority" },
    { id: "Name", label: "Name (A–Z)" },
    { id: "Duration", label: "Total work" },
    { id: "Operations", label: "Number of ops" },
] as const;

export const DEFAULT_SORT: (typeof SORT_OPTIONS)[number]["id"] = "Priority";

const PRIORITY_RANK: Record<Priority, number> = { High: 0, Med: 1, Low: 2 };

export function draftFromJob(job: JobDef): JobDraft {
    return { ...job, operations: job.operations.map((operation) => ({ ...operation, routes: operation.routes.map((route) => ({ ...route })) })) };
}

/**
 * The number each job is known by in the UI, replacing its UUID.
 *
 * Job names are not unique — the backend says so explicitly, because two real
 * jobs can both be "Repair conveyor" — so a name alone cannot always tell two
 * rows apart. The sequence number is taken from creation order, the same
 * ordering that hands out colour slots, so a job keeps its number while it
 * exists no matter how the list is currently sorted or filtered.
 *
 * It is an ordinal, not an identifier: deleting job #2 renumbers what follows.
 * That is why it is only ever shown, never sent to the API or used as a key.
 */
export function jobSequenceNumbers(jobs: readonly JobDef[]): ReadonlyMap<string, number> {
    return new Map(stableJobOrder(jobs).map((job, index) => [job.id, index + 1]));
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
        // Search covers the name only. The id is a UUID the manager never sees,
        // so matching against it could only ever produce results they cannot
        // explain from what is on screen.
        if (needle && !job.name.toLowerCase().includes(needle)) return false;
        if (filters.priority !== "All" && job.priority !== filters.priority) return false;
        if (filters.machineId !== "All" && !job.operations.some((operation) => operation.routes.some((route) => route.machineId === filters.machineId))) return false;
        const work = totalWorkMins(job);
        return (filters.duration !== "Short" || work < 60) &&
            (filters.duration !== "Medium" || (work >= 60 && work < 240)) &&
            (filters.duration !== "Long" || work >= 240);
    });
    return [...matching].sort((left, right) => {
        if (filters.sort === "Priority") {
            const byPriority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
            // Within one priority, name keeps the list stable and scannable
            // rather than leaving equal-priority jobs in fetch order.
            return byPriority !== 0 ? byPriority : left.name.localeCompare(right.name);
        }
        if (filters.sort === "Name") return left.name.localeCompare(right.name);
        if (filters.sort === "Duration") return totalWorkMins(right) - totalWorkMins(left);
        return right.operations.length - left.operations.length;
    });
}
