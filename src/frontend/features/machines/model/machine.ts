import type { BacklogStatus, JobDef } from "@/domains/scheduling/types";
import type { MachineCategory, MachineInput, MachineSummary } from "../data/api";

export type { MachineCategory, MachineSummary } from "../data/api";

export interface MachineDraft {
    id: string | null;
    name: string;
    categoryId: string | null;
    salary: string;
    active: boolean;
}

export const EMPTY_MACHINE_DRAFT: MachineDraft = {
    id: null,
    name: "",
    categoryId: null,
    salary: "",
    active: true,
};

export function draftFromMachine(machine: MachineSummary): MachineDraft {
    return {
        id: machine.id,
        name: machine.name,
        categoryId: machine.category_id,
        salary: machine.salary ?? "",
        active: machine.active,
    };
}

export function machineInputFromDraft(draft: MachineDraft): MachineInput {
    const salary = draft.salary.trim();
    return {
        name: draft.name.trim(),
        category_id: draft.categoryId,
        salary: salary === "" ? null : salary,
        active: draft.active,
    };
}

/**
 * A value that changes whenever the draft does, for spotting unsaved work.
 *
 * Compared against the machine as the API last returned it. Only what a save
 * sends is included, and in the shape it is sent, so typing a trailing space
 * into the name — which the API strips anyway — never reads as an edit.
 */
export function draftFingerprint(draft: MachineDraft): string {
    const { name, category_id, salary, active } = machineInputFromDraft(draft);
    return JSON.stringify({ name, category_id, salary: normaliseSalary(salary), active });
}

/** "25", "25.0" and "25.00" are the same salary; the API echoes the last. */
function normaliseSalary(salary: string | null | undefined): string | null {
    if (salary === null || salary === undefined) return null;
    const value = Number(salary);
    return Number.isFinite(value) ? value.toFixed(2) : salary;
}

/**
 * The salary column is `Numeric(10, 2)`: eight digits before the point and two
 * after. More decimals would be rounded by the database without a word, and
 * more digits would be refused, so both are caught before a round trip.
 */
const SALARY_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;

/**
 * Why this draft cannot be saved yet, or null when it can.
 *
 * The API stays the authority. This only covers what is knowable without
 * asking, where a round trip could only come back with a refusal the manager
 * already had the information to avoid.
 */
export function draftProblem(draft: MachineDraft, machines: readonly MachineSummary[]): string | null {
    const name = draft.name.trim();
    if (name === "") return "Give the machine a name before saving.";
    // Names are unique on the floor (and compared exactly, as the database does).
    if (machines.some((machine) => machine.id !== draft.id && machine.name === name)) {
        return `Another machine is already called “${name}”.`;
    }
    const salary = draft.salary.trim();
    if (salary !== "" && !SALARY_PATTERN.test(salary)) {
        return "Hourly salary must be a positive amount with at most two decimal places.";
    }
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

/** The one answer to "can this be saved yet", shared by the button and Ctrl+S. */
export function saveGate(input: { isNew: boolean; dirty: boolean; problem: string | null }): SaveGate {
    // A pristine new form has nothing in it to complain about yet.
    if (input.isNew && !input.dirty) return { canSave: false, reason: null, held: false };
    if (input.problem !== null) return { canSave: false, reason: input.problem, held: true };
    if (!input.dirty) return { canSave: false, reason: "No unsaved changes.", held: false };
    return { canSave: true, reason: null, held: false };
}

/** A job that routes at least one of its operations through a machine. */
export interface MachineJobUse {
    id: string;
    name: string;
    backlogStatus: BacklogStatus;
    /** How many of the job's operations can run on this machine. */
    operationCount: number;
}

export interface MachineUsage {
    /** Operation routes naming this machine — what the API refuses a removal over. */
    operationCount: number;
    jobs: MachineJobUse[];
}

export const NO_USAGE: MachineUsage = { operationCount: 0, jobs: [] };

/**
 * Which jobs depend on each machine, keyed by machine id.
 *
 * Built from every job definition, archived ones included: the API counts
 * those routes too when it decides whether a machine may be removed, so
 * leaving them out would offer a removal that is only ever refused.
 */
export function machineUsage(jobs: readonly JobDef[]): ReadonlyMap<string, MachineUsage> {
    const usage = new Map<string, MachineUsage>();
    for (const job of jobs) {
        const perMachine = new Map<string, number>();
        for (const operation of job.operations) {
            for (const machineId of new Set(operation.routes.map((route) => route.machineId))) {
                perMachine.set(machineId, (perMachine.get(machineId) ?? 0) + 1);
            }
        }
        for (const [machineId, operationCount] of perMachine) {
            const entry = usage.get(machineId) ?? { operationCount: 0, jobs: [] };
            entry.operationCount += operationCount;
            entry.jobs.push({
                id: job.id,
                name: job.name,
                backlogStatus: job.backlogStatus ?? "archived",
                operationCount,
            });
            usage.set(machineId, entry);
        }
    }
    // Open work first: that is what a change to this machine affects next.
    for (const entry of usage.values()) {
        entry.jobs.sort((left, right) =>
            Number(left.backlogStatus !== "open") - Number(right.backlogStatus !== "open") ||
            left.name.localeCompare(right.name),
        );
    }
    return usage;
}

export interface MachineRow {
    id: string;
    name: string;
    categoryId: string | null;
    categoryLabel: string;
    active: boolean;
    statusLabel: "Active" | "Inactive";
    /** Open jobs routed through this machine; null while the jobs are loading. */
    openJobCount: number | null;
}

export function toMachineRow(
    machine: MachineSummary,
    categoryNames: ReadonlyMap<string, string>,
    usage: ReadonlyMap<string, MachineUsage> | null,
): MachineRow {
    return {
        id: machine.id,
        name: machine.name,
        categoryId: machine.category_id,
        categoryLabel: categoryLabel(machine.category_id, categoryNames),
        active: machine.active,
        statusLabel: machine.active ? "Active" : "Inactive",
        openJobCount: usage === null
            ? null
            : (usage.get(machine.id) ?? NO_USAGE).jobs.filter((job) => job.backlogStatus === "open").length,
    };
}

export function categoryLabel(categoryId: string | null, categoryNames: ReadonlyMap<string, string>): string {
    return categoryId ? categoryNames.get(categoryId) ?? "Unknown category" : "No category";
}

export function categoryNames(categories: MachineCategory[]): ReadonlyMap<string, string> {
    return new Map(categories.map((category) => [category.id, category.name]));
}

export const STATUS_FILTERS = [
    { id: "all", label: "All machines" },
    { id: "active", label: "Active" },
    { id: "inactive", label: "Inactive" },
] as const;

/** The category filter's "match anything" and "match uncategorised" choices. */
export const ANY_CATEGORY = "__any";
export const NO_CATEGORY = "__none";

export const SORT_OPTIONS = [
    { id: "Name", label: "Name (A–Z)" },
    { id: "Category", label: "Category" },
    { id: "Usage", label: "Most open jobs" },
    { id: "Status", label: "Active first" },
] as const;

export interface MachineFilters {
    query: string;
    status: (typeof STATUS_FILTERS)[number]["id"];
    categoryId: string;
    sort: (typeof SORT_OPTIONS)[number]["id"];
}

export const INITIAL_MACHINE_FILTERS: MachineFilters = {
    query: "",
    status: "all",
    categoryId: ANY_CATEGORY,
    sort: "Name",
};

export function filtersActive(filters: MachineFilters): boolean {
    return (
        filters.query.trim() !== "" ||
        filters.status !== INITIAL_MACHINE_FILTERS.status ||
        filters.categoryId !== INITIAL_MACHINE_FILTERS.categoryId
    );
}

export function filterMachineRows(rows: readonly MachineRow[], filters: MachineFilters): MachineRow[] {
    const needle = filters.query.trim().toLowerCase();
    const matching = rows.filter((row) => {
        // Name and category only. The id is a UUID the manager never sees, so
        // matching on it could only produce results nothing on screen explains.
        if (needle && !row.name.toLowerCase().includes(needle) && !row.categoryLabel.toLowerCase().includes(needle)) {
            return false;
        }
        if (filters.status !== "all" && (filters.status === "active") !== row.active) return false;
        if (filters.categoryId === ANY_CATEGORY) return true;
        return filters.categoryId === NO_CATEGORY ? row.categoryId === null : row.categoryId === filters.categoryId;
    });
    return matching.sort((left, right) => {
        const byName = left.name.localeCompare(right.name);
        if (filters.sort === "Category") return left.categoryLabel.localeCompare(right.categoryLabel) || byName;
        if (filters.sort === "Usage") return (right.openJobCount ?? 0) - (left.openJobCount ?? 0) || byName;
        if (filters.sort === "Status") return Number(right.active) - Number(left.active) || byName;
        return byName;
    });
}
