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
    return {
        name: draft.name.trim(),
        category_id: draft.categoryId,
        salary: draft.salary.trim() === "" ? null : draft.salary.trim(),
        active: draft.active,
    };
}

export function isValidMachineSalary(value: string): boolean {
    if (value.trim() === "") return true;
    const salary = Number(value);
    return Number.isFinite(salary) && salary >= 0;
}

export interface MachineRow {
    id: string;
    name: string;
    categoryLabel: string;
    active: boolean;
    statusLabel: "Active" | "Inactive";
}

export function toMachineRow(
    machine: MachineSummary,
    categoryNames: ReadonlyMap<string, string>,
): MachineRow {
    return {
        id: machine.id,
        name: machine.name,
        categoryLabel: machine.category_id ? categoryNames.get(machine.category_id) ?? "Unknown" : "No category",
        active: machine.active,
        statusLabel: machine.active ? "Active" : "Inactive",
    };
}

export function categoryNames(categories: MachineCategory[]): ReadonlyMap<string, string> {
    return new Map(categories.map((category) => [category.id, category.name]));
}
