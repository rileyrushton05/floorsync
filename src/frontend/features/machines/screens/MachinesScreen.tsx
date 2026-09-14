"use client";

import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import type { MachineSummary } from "../data/api";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
    EMPTY_MACHINE_DRAFT,
    draftFromMachine,
    isValidMachineSalary,
    machineInputFromDraft,
    toMachineRow,
    type MachineDraft,
} from "@/features/machines/model/machine";
import { useMachineCategories, useMachines, useSaveMachine } from "@/features/machines/data/queries";
import { MachineEditor } from "@/features/machines/ui/MachineEditor";
import { MachineInventoryPanel } from "@/features/machines/ui/MachineInventoryPanel";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";

export default function MachinesPage() {
    const machineQuery = useMachines();
    const categoryQuery = useMachineCategories();
    const saveMachine = useSaveMachine();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<MachineDraft>(EMPTY_MACHINE_DRAFT);
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

    const machines = useMemo(() => machineQuery.data ?? [], [machineQuery.data]);
    const categories = useMemo(() => categoryQuery.data ?? [], [categoryQuery.data]);
    const saving = saveMachine.isPending;
    const categoryName = useMemo(
        () => new Map(categories.map((category) => [category.id, category.name])),
        [categories],
    );
    const selected = machines.find((machine) => machine.id === selectedId) ?? null;
    const filteredMachines = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return machines.filter((machine) => {
            if (needle && !machine.name.toLowerCase().includes(needle) && !machine.id.toLowerCase().includes(needle)) {
                return false;
            }
            return statusFilter === "all" || (statusFilter === "active") === machine.active;
        });
    }, [machines, query, statusFilter]);
    const filteredRows = useMemo(
        () => filteredMachines.map((machine) => toMachineRow(machine, categoryName)),
        [categoryName, filteredMachines],
    );

    const beginCreate = useCallback(() => {
        setSelectedId(null);
        setDraft(EMPTY_MACHINE_DRAFT);
    }, []);

    const selectMachine = useCallback((machine: MachineSummary) => {
        setSelectedId(machine.id);
        setDraft(draftFromMachine(machine));
    }, []);

    async function save() {
        if (saving) return;
        if (draft.name.trim() === "") {
            toast.error("Give the machine a name.");
            return;
        }
        if (!isValidMachineSalary(draft.salary)) {
            toast.error("Salary must be a non-negative number.");
            return;
        }

        try {
            const saved = await saveMachine.mutateAsync({ id: draft.id, values: machineInputFromDraft(draft) });
            setSelectedId(saved.id);
            setDraft(draftFromMachine(saved));
            toast.success(draft.id ? `${saved.name} updated.` : `${saved.name} added to the floor.`);
        } catch (error) {
            toast.error(errorMessage(error));
        }
    }

    async function deactivate() {
        if (!selected || saving) return;
        try {
            const saved = await saveMachine.mutateAsync({ id: selected.id, values: { active: false } });
            setDraft(draftFromMachine(saved));
            toast.success(`${saved.name} deactivated.`);
        } catch (error) {
            toast.error(errorMessage(error));
        }
    }

    if (machineQuery.isPending || categoryQuery.isPending) {
        return <ManagerPageState title="Loading machines…">Reading the floor inventory and categories from the API.</ManagerPageState>;
    }
    const loadError = machineQuery.error ?? categoryQuery.error;
    if (loadError instanceof ApiError && loadError.isForbidden) {
        return <ManagerPageState title="This needs a manager account">Machine administration is restricted to managers.</ManagerPageState>;
    }
    if (loadError) {
        return (
            <ManagerPageState title="Could not load machines" error>
                <p>{errorMessage(loadError)}</p>
                <Button
                    intent="outline"
                    size="sm"
                    className="mt-3"
                    onPress={() => void Promise.all([machineQuery.refetch(), categoryQuery.refetch()])}
                >
                    Try again
                </Button>
            </ManagerPageState>
        );
    }

    return (
        <ManagerShell actions={<Button onPress={beginCreate} isDisabled={saving}><PlusIcon /> Add machine</Button>}>
            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(280px,0.8fr)_2fr]">
                <MachineInventoryPanel total={machines.length} rows={filteredRows} selectedId={selectedId} query={query} statusFilter={statusFilter} onQueryChange={setQuery} onStatusFilterChange={setStatusFilter} onSelect={(id) => { const machine = machines.find((candidate) => candidate.id === id); if (machine) selectMachine(machine); }} />
                <MachineEditor draft={draft} selected={selected} categories={categories} categoryNames={categoryName} saving={saving} onDraftChange={(update) => setDraft(update)} onSave={() => void save()} onDeactivate={() => void deactivate()} />
            </main>
        </ManagerShell>
    );
}
