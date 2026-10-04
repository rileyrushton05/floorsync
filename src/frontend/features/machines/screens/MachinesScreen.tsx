"use client";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/core/feedback/ConfirmDialog";
import { reportBackendFailure, reportMutationError } from "@/core/feedback/reportMutationError";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { useJobDefinitions } from "@/features/jobs/data/queries";
import { useDeleteMachine, useMachineCategories, useMachines, useSaveMachine } from "@/features/machines/data/queries";
import {
    EMPTY_MACHINE_DRAFT,
    draftFromMachine,
    machineInputFromDraft,
    toMachineRow,
    type MachineDraft,
} from "@/features/machines/model/machine";
import { DeleteMachineDialog } from "@/features/machines/ui/DeleteMachineDialog";
import { MachineEditor } from "@/features/machines/ui/MachineEditor";
import { MachineInventoryPanel } from "@/features/machines/ui/MachineInventoryPanel";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { MachineSummary } from "../data/api";

export default function MachinesPage() {
    const machineQuery = useMachines();
    const categoryQuery = useMachineCategories();
    const saveMachine = useSaveMachine();
    const deleteMachine = useDeleteMachine();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<MachineDraft>(EMPTY_MACHINE_DRAFT);
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
    const [confirmDeactivate, setConfirmDeactivate] = useState(false);
    const [confirmRemove, setConfirmRemove] = useState(false);
    // The machine that was open when "Add machine" was pressed, so cancelling
    // the new one goes back to it.
    const [returnId, setReturnId] = useState<string | null>(null);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const jobDefinitionsQuery = useJobDefinitions();

    const machines = useMemo(() => machineQuery.data ?? [], [machineQuery.data]);
    const categories = useMemo(() => categoryQuery.data ?? [], [categoryQuery.data]);
    const categoryName = useMemo(
        () => new Map(categories.map((category) => [category.id, category.name])),
        [categories],
    );
    const selected = machines.find((machine) => machine.id === selectedId) ?? null;
    // Safeguard: a machine that is referenced by any operation route in a job
    // definition is still needed by the scheduler and must not be removed.
    const assignedOperationCount = useMemo(() => {
        if (!selected) return 0;
        return (jobDefinitionsQuery.data ?? []).reduce(
            (total, job) => total + job.operations.reduce(
                (ops, operation) => ops + operation.routes.filter((route) => route.machineId === selected.id).length,
                0,
            ),
            0,
        );
    }, [jobDefinitionsQuery.data, selected]);
    const machineInUse = assignedOperationCount > 0;
    const saving = saveMachine.isPending || deleteMachine.isPending;
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
        setReturnId((previous) => selectedId ?? previous);
        setSelectedId(null);
        setDraft(EMPTY_MACHINE_DRAFT);
    }, [selectedId]);

    // A new machine has something to lose once any field has been filled in.
    const newDraftTouched =
        draft.id === null &&
        (draft.name !== "" || draft.categoryId !== null || draft.salary !== "");
    const returnMachine = machines.find((machine) => machine.id === returnId) ?? null;

    /** Leave the new machine: back to the one it was started from, or a blank form. */
    function cancelCreate() {
        setConfirmCancel(false);
        if (returnMachine) selectMachine(returnMachine);
        else setDraft(EMPTY_MACHINE_DRAFT);
    }

    function requestCancelCreate() {
        if (newDraftTouched) setConfirmCancel(true);
        else cancelCreate();
    }

    const selectMachine = useCallback((machine: MachineSummary) => {
        setSelectedId(machine.id);
        setDraft(draftFromMachine(machine));
    }, []);

    async function save() {
        if (saving) return;
        try {
            const saved = await saveMachine.mutateAsync({ id: draft.id, values: machineInputFromDraft(draft) });
            setSelectedId(saved.id);
            setDraft(draftFromMachine(saved));
            toast.success(draft.id ? `${saved.name} updated.` : `${saved.name} added to the floor.`);
        } catch (error) {
            reportMutationError(error);
        }
    }

    /** Retire an active machine, or restore an inactive one; no confirm needed to re-activate. */
    function requestDeactivate() {
        if (!selected || saving) return;
        if (selected.active) setConfirmDeactivate(true);
        else void toggleActive();
    }

    async function toggleActive() {
        if (!selected || saveMachine.isPending) return;
        try {
            const saved = await saveMachine.mutateAsync({ id: selected.id, values: { active: !selected.active } });
            setDraft(draftFromMachine(saved));
            setConfirmDeactivate(false);
            toast.success(`${saved.name} ${saved.active ? "activated" : "deactivated"}.`);
        } catch (error) {
            reportMutationError(error);
        }
    }

    /** Hard removal; guarded against active machines and the
        assigned-operations count, confirmed via DeleteMachineDialog. */
    function requestRemove() {
        if (!selected || saving) return;
        if (machineInUse) {
            reportBackendFailure(
                `${selected.name} cannot be removed: ${assignedOperationCount} operation${assignedOperationCount === 1 ? " is" : "s are"} still assigned to it. Unassign or re-route those operations first.`,
            );
            return;
        }
        if (selected.active) {
            reportBackendFailure(
                `${selected.name} is still active. Deactivate it before removing it from the floor.`,
            );
            return;
        }
        setConfirmRemove(true);
    }

    async function remove() {
        if (!selected) return;
        const removedName = selected.name;
        try {
            await deleteMachine.mutateAsync(selected.id);
            setConfirmRemove(false);
            setSelectedId(null);
            setDraft(EMPTY_MACHINE_DRAFT);
            toast.success(`${removedName} removed from the floor.`);
        } catch (error) {
            reportMutationError(error);
            setConfirmRemove(false);
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
                <MachineEditor draft={draft} selected={selected} categories={categories} categoryNames={categoryName} saving={saving} assignedOperationCount={assignedOperationCount} onDraftChange={(update) => setDraft(update)} onSave={() => void save()} onCancelNew={returnMachine || newDraftTouched ? requestCancelCreate : undefined} onDeactivate={requestDeactivate} onRemove={requestRemove} />
            </main>
            {confirmDeactivate && selected && (
                <ConfirmDialog
                    title={`Deactivate ${selected.name}?`}
                    description={<>The machine and its existing operation routes stay in history, but it will be excluded from future scheduling.</>}
                    confirmLabel="Deactivate machine"
                    danger
                    onConfirm={() => void toggleActive()}
                    onCancel={() => setConfirmDeactivate(false)}
                />
            )}
            {confirmCancel && (
                <ConfirmDialog
                    title="Cancel this new machine?"
                    description={`“${draft.name.trim() || "This new machine"}” has not been added yet. Cancelling throws it away.`}
                    confirmLabel="Discard machine"
                    cancelLabel="Keep editing"
                    danger
                    onConfirm={cancelCreate}
                    onCancel={() => setConfirmCancel(false)}
                />
            )}
            {confirmRemove && selected && (
                <DeleteMachineDialog
                    machineName={selected.name}
                    closing={false}
                    onConfirm={() => void remove()}
                    onDismiss={() => setConfirmRemove(false)}
                />
            )}
        </ManagerShell>
    );
}
