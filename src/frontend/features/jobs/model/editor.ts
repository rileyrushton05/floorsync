import { stableJobOrder } from "@/domains/scheduling/colors";
import type { DependencyEdge } from "../data/api";
import { chainDependsOn, dependsOnFromEdges, foreignEdgesFor } from "./dependencies";
import { totalWorkMins } from "@/domains/scheduling/format";
import type { BacklogStatus, JobDef, OperationDef, Priority } from "@/domains/scheduling/types";

/**
 * An operation as the builder edits it: the shared domain shape plus the
 * precedence the editor owns.
 *
 * `dependsOn` lives here rather than on `OperationDef` because it is a builder
 * concern — the schedule timeline carries resolved start times, not the graph
 * they came from.
 */
export interface DraftOperation extends OperationDef {
    /** Ids of operations in this job that must finish before this one starts. */
    dependsOn: string[];
}

export interface JobDraft {
    id: string | null;
    name: string;
    priority: Priority;
    /** Derived by the backend; any non-open status is read-only here. */
    archivedAt: string | null;
    backlogStatus: BacklogStatus;
    plannedByScheduleIds: string[];
    operations: DraftOperation[];
    /**
     * Edges into this job from an operation in another job.
     *
     * Not editable and not drawn — the diagram only knows this job's steps — but
     * carried on the draft so a save can write them back. The ordering endpoint
     * replaces every edge pointing into the job, so a draft that dropped these
     * would delete them.
     */
    foreignEdges: DependencyEdge[];
}

export const EMPTY_JOB_DRAFT: JobDraft = {
    id: null,
    name: "",
    priority: "Med",
    archivedAt: null,
    backlogStatus: "open",
    plannedByScheduleIds: [],
    operations: [],
    foreignEdges: [],
};
export const JOB_PRIORITIES: { id: Priority }[] = [{ id: "High" }, { id: "Med" }, { id: "Low" }];

/**
 * Whether the list shows open jobs, retired ones, or both.
 *
 * Defaults to `Active` because that is the backlog — the work still to be done.
 * Archived jobs are fetched all the same (`include_archived`), so switching is
 * a filter rather than a refetch, and a manager looking for a finished job to
 * copy can find it without leaving the screen.
 */
export const STATUS_FILTERS = [
    { id: "Active", label: "Active jobs" },
    { id: "Planned", label: "Planned jobs" },
    { id: "Archived", label: "Archived jobs" },
    { id: "All", label: "All jobs" },
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
    { id: "Duration", label: "Duration" },
    { id: "Operations", label: "Number of ops" },
] as const;

export const DEFAULT_SORT: (typeof SORT_OPTIONS)[number]["id"] = "Priority";

const PRIORITY_RANK: Record<Priority, number> = { High: 0, Med: 1, Low: 2 };

/**
 * Open a saved job in the editor.
 *
 * Precedence starts as the straight chain the operation order implies, which is
 * what the definition endpoint stores for any job this builder has saved. The
 * job's real graph arrives from its own endpoint and is applied over this once
 * it loads — see `applyDependencies`.
 */
export function draftFromJob(job: JobDef): JobDraft {
    const chain = chainDependsOn(job.operations.map((operation) => operation.id));
    return {
        ...job,
        archivedAt: job.archivedAt ?? null,
        // A response missing this required API field must never turn a saved
        // job editable. Treat it like an archived record until the API reply is
        // corrected or the page refreshes with a complete contract.
        backlogStatus: job.backlogStatus ?? "archived",
        plannedByScheduleIds: job.plannedByScheduleIds ?? [],
        foreignEdges: [],
        operations: job.operations.map((operation) => ({
            ...operation,
            routes: operation.routes.map((route) => ({ ...route })),
            dependsOn: chain.get(operation.id) ?? [],
        })),
    };
}

/** Replace the draft's precedence with the graph the API actually holds. */
export function applyDependencies(draft: JobDraft, edges: readonly DependencyEdge[]): JobDraft {
    const operationIds = draft.operations.map((operation) => operation.id);
    const dependsOn = dependsOnFromEdges(operationIds, edges);
    return {
        ...draft,
        foreignEdges: foreignEdgesFor(operationIds, edges),
        operations: draft.operations.map((operation) => ({
            ...operation,
            dependsOn: dependsOn.get(operation.id) ?? [],
        })),
    };
}

/**
 * An unsaved copy of a job, ready to be edited and created as a new one.
 *
 * This is the way back from an archived job: archived work is shown read-only,
 * so "change it" means "make a new job that starts where this one left off".
 * The copy is deliberately *not* written yet — it opens in the editor as a new
 * job with unsaved changes, so a manager renames and adjusts it before anything
 * reaches the API, exactly as if they had built it by hand.
 *
 * Every operation gets a fresh placeholder id and the precedence is rewritten
 * onto those ids, so the copy's graph matches the original's shape without
 * naming any of its rows. `foreignEdges` are dropped rather than carried: they
 * point *into* the original's operations from another job, and nothing about
 * copying this job says another job should now wait on the copy as well.
 */
export function duplicateDraft(draft: JobDraft): JobDraft {
    const copiedId = (index: number) => `new-op-copy-${index + 1}`;
    const copiedIdFor = new Map(
        draft.operations.map((operation, index) => [operation.id, copiedId(index)]),
    );
    return {
        id: null,
        name: `${draft.name.trim()} (copy)`.trim(),
        priority: draft.priority,
        archivedAt: null,
        backlogStatus: "open",
        plannedByScheduleIds: [],
        foreignEdges: [],
        operations: draft.operations.map((operation, index) => ({
            id: copiedId(index),
            name: operation.name,
            routes: operation.routes.map((route) => ({ ...route })),
            dependsOn: operation.dependsOn.flatMap((id) => {
                const copied = copiedIdFor.get(id);
                return copied === undefined ? [] : [copied];
            }),
        })),
    };
}

/**
 * A value that changes whenever the draft does, for spotting unsaved work.
 *
 * Compared against a snapshot taken whenever the draft is set from an
 * authoritative source — opening a job, its graph arriving, a successful save.
 * Everything a save actually sends is included and nothing else, so a draft
 * that round-trips unchanged never reads as dirty.
 *
 * Predecessors are sorted because the order they were clicked in is not part of
 * the job: picking A then B and picking B then A submit the same graph.
 *
 * Cross-job edges are left out: nothing on this screen can change them, so they
 * could only ever produce a draft that reads as dirty without an edit.
 */
export function draftFingerprint(draft: JobDraft): string {
    return JSON.stringify({
        name: draft.name,
        priority: draft.priority,
        operations: draft.operations.map((operation) => ({
            id: operation.id,
            name: operation.name,
            dependsOn: [...operation.dependsOn].sort(),
            routes: operation.routes.map((route) => ({
                machineId: route.machineId,
                durationMins: route.durationMins,
                energy: route.energy,
            })),
        })),
    });
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

/**
 * Why this draft cannot be saved yet, or null when it can.
 *
 * The API remains the authority on whether a job is acceptable — this only
 * covers the handful of cases where the answer is knowable without asking, and
 * where a round trip could only come back with a message the manager already
 * had the information to avoid. Everything else is still reported by the API.
 */
export function draftProblem(draft: JobDraft): string | null {
    if (draft.name.trim() === "") return "Give the job a name before saving.";
    if (draft.operations.length === 0) return "A job needs at least one operation.";
    const unnamed = draft.operations.findIndex((operation) => operation.name.trim() === "");
    if (unnamed >= 0) return `Step ${unnamed + 1} needs a name.`;
    const routeless = draft.operations.find((operation) => operation.routes.length === 0);
    if (routeless) return `“${routeless.name.trim()}” needs at least one machine.`;
    const undurated = draft.operations.find((operation) =>
        operation.routes.some((route) => !Number.isFinite(route.durationMins) || route.durationMins < 1),
    );
    if (undurated) return `“${undurated.name.trim()}” has a machine with no duration.`;
    return null;
}

/** Whether a draft can be written, and what to say when it cannot. */
export interface SaveGate {
    canSave: boolean;
    /** Shown beside the save button, and raised if a save is asked for anyway. */
    reason: string | null;
    /** True when there is work to write but something is standing in the way. */
    held: boolean;
}

/**
 * The one answer to "can this be saved yet", shared by the button and Ctrl+S.
 *
 * Two places can ask for a save, and a shortcut that saves what a disabled
 * button refuses — or refuses what the button offers — is worse than having no
 * shortcut at all. So the condition lives here and neither of them owns it.
 *
 * `held` separates "nothing to do" from "something is in the way": pressing
 * Ctrl+S on an unchanged job should do nothing quietly, while pressing it on a
 * draft that cannot be written yet has to say why.
 */
export function saveGate(input: {
    isNew: boolean;
    dirty: boolean;
    problem: string | null;
    graphReady: boolean;
    graphFailed: boolean;
    loading: boolean;
    hasLoadError: boolean;
    /** The job has left the open backlog, so the editor is read-only. */
    readOnly: boolean;
}): SaveGate {
    if (input.loading || input.hasLoadError) {
        return { canSave: false, reason: null, held: input.dirty };
    }
    // Ahead of everything else, including the graph: a job outside the active backlog is not
    // being saved whatever else is true of it, and saying why is more use than
    // reporting a load state for a write that is not on offer.
    if (input.readOnly) {
        return {
            canSave: false,
            reason: "This job has left the active backlog. Duplicate it to make changes.",
            // `held`, so an explicit Ctrl+S answers rather than doing nothing
            // quietly: the editor looks editable enough to try saving, and
            // silence would read as the shortcut being broken.
            held: true,
        };
    }
    if (!input.graphReady) {
        return {
            canSave: false,
            reason: input.graphFailed
                ? "This job's step order could not be loaded, so saving would overwrite it."
                : "Loading this job's step order…",
            held: true,
        };
    }
    if (input.problem !== null) return { canSave: false, reason: input.problem, held: true };
    if (!input.dirty) {
        return { canSave: false, reason: input.isNew ? null : "No unsaved changes.", held: false };
    }
    return { canSave: true, reason: null, held: false };
}

export interface JobFilters {
    query: string;
    status: (typeof STATUS_FILTERS)[number]["id"];
    // Not offered as a control; only set by a link from another screen
    // (?machine=<id>) to narrow the backlog to the jobs routed through it.
    machineId: string;
    sort: (typeof SORT_OPTIONS)[number]["id"];
}

export function filterJobs(jobs: JobDef[], filters: JobFilters): JobDef[] {
    const needle = filters.query.trim().toLowerCase();
    const matching = jobs.filter((job) => {
        // Search covers the name only. The id is a UUID the manager never sees,
        // so matching against it could only ever produce results they cannot
        // explain from what is on screen.
        if (needle && !job.name.toLowerCase().includes(needle)) return false;
        const status = job.backlogStatus ?? "archived";
        if (filters.status === "Active" && status !== "open") return false;
        if (filters.status === "Planned" && status !== "planned" && status !== "done") return false;
        if (filters.status === "Archived" && status !== "archived") return false;
        return filters.machineId === "All" || job.operations.some((operation) => operation.routes.some((route) => route.machineId === filters.machineId));
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
