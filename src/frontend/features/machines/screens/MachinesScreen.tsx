"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Note } from "@/components/ui/note";
import { ConfirmDialog } from "@/core/feedback/ConfirmDialog";
import { PageMessage } from "@/core/feedback/PageMessage";
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { useSaveShortcut } from "@/core/keyboard/useSaveShortcut";
import { useNavigationGuard } from "@/core/navigation/NavigationGuard";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { SidePane, SidePaneLayout, SidePaneMain } from "@/core/shell/SidePanes";
import { useJobDefinitions } from "@/features/jobs/data/queries";
import { useDeleteMachine, useMachineCategories, useMachines, useSaveMachine } from "@/features/machines/data/queries";
import {
    EMPTY_MACHINE_DRAFT,
    INITIAL_MACHINE_FILTERS,
    NO_USAGE,
    categoriesInUse,
    categoryNames,
    draftFingerprint,
    draftFromMachine,
    draftProblem,
    filterMachineRows,
    machineInputFromDraft,
    machineUsage,
    saveGate,
    toMachineRow,
    type MachineDraft,
    type MachineFilters,
    type MachineSummary,
} from "@/features/machines/model/machine";
import { DeleteMachineDialog } from "@/features/machines/ui/DeleteMachineDialog";
import { MachineEditor } from "@/features/machines/ui/MachineEditor";
import { MachineInventoryPanel } from "@/features/machines/ui/MachineInventoryPanel";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

/** How long the remove dialog's zoom-out runs before it unmounts, in ms. */
const CLOSE_MS = 150;

/** A switch held back until unsaved work is dealt with. */
type PendingOpen =
    | { kind: "machine"; machine: MachineSummary }
    | { kind: "new" }
    | { kind: "cancel"; machine: MachineSummary | null };

export default function MachinesPage() {
    return (
        <Suspense>
            <MachinesPageInner />
        </Suspense>
    );
}

function MachinesPageInner() {
    const machineQuery = useMachines();
    const categoryQuery = useMachineCategories();
    const jobDefinitionsQuery = useJobDefinitions();
    const saveMachine = useSaveMachine();
    const deleteMachine = useDeleteMachine();
    const searchParams = useSearchParams();

    // The machine as the API has it, and the form's copy of it. Anything the
    // draft says differently is unsaved work, which the leave warnings key off.
    const [draft, setDraft] = useState<MachineDraft>(EMPTY_MACHINE_DRAFT);
    const [baselineDraft, setBaselineDraft] = useState<MachineDraft>(EMPTY_MACHINE_DRAFT);
    const [isCreating, setIsCreating] = useState(false);
    const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);
    // The machine that was open when "New Machine" was pressed, so cancelling
    // the new one goes back to it.
    const [returnId, setReturnId] = useState<string | null>(null);
    const [filters, setFilters] = useState<MachineFilters>(INITIAL_MACHINE_FILTERS);
    const [confirmDeactivate, setConfirmDeactivate] = useState(false);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [removeClosing, setRemoveClosing] = useState(false);

    const machines = useMemo(() => machineQuery.data ?? [], [machineQuery.data]);
    const categories = useMemo(() => categoryQuery.data ?? [], [categoryQuery.data]);
    const categoryName = useMemo(() => categoryNames(categories), [categories]);
    // Null until the job definitions arrive: "no jobs use this" and "not
    // known yet" must not look the same, or removal would be offered early.
    const usage = useMemo(
        () => (jobDefinitionsQuery.data ? machineUsage(jobDefinitionsQuery.data) : null),
        [jobDefinitionsQuery.data],
    );
    const rows = useMemo(
        () => machines.map((machine) => toMachineRow(machine, categoryName, usage)),
        [categoryName, machines, usage],
    );
    const visibleRows = useMemo(() => filterMachineRows(rows, filters), [filters, rows]);
    const filterCategories = useMemo(
        () => categoriesInUse(categories, machines, filters.categoryId),
        [categories, filters.categoryId, machines],
    );
    const draftCategories = useMemo(
        () => categoriesInUse(categories, machines, draft.categoryId),
        [categories, draft.categoryId, machines],
    );
    const activeCount = useMemo(() => machines.filter((machine) => machine.active).length, [machines]);

    const selected = draft.id === null ? null : machines.find((machine) => machine.id === draft.id) ?? null;
    const selectedUsage = selected === null || usage === null ? null : usage.get(selected.id) ?? NO_USAGE;
    const saving = saveMachine.isPending || deleteMachine.isPending;
    const dirty = draftFingerprint(draft) !== draftFingerprint(baselineDraft);
    const gate = saveGate({ isNew: draft.id === null, dirty, problem: draftProblem(draft, machines) });

    // The screen opens with nothing selected: the right pane shows a neutral
    // empty state until a machine is picked in the list, or "New Machine" is
    // pressed. Only a ?machine=<id> link or user action opens the editor.

    // The machine on screen was removed elsewhere (or in another tab): drop
    // it rather than leave a form that can only ever save into a 404.
    if (draft.id !== null && machineQuery.isSuccess && !machineQuery.isFetching && !saving && selected === null) {
        openDraft(EMPTY_MACHINE_DRAFT);
    }

    // Another screen can link straight to a machine (?machine=<id>). Starts
    // null so the link is only marked handled once there is a list to match it
    // against; adjusting state during render avoids an effect's extra pass.
    const requestedId = searchParams.get("machine");
    const [lastOpenedId, setLastOpenedId] = useState<string | null>(null);
    if (requestedId && requestedId !== lastOpenedId) {
        const match = machines.find((machine) => machine.id === requestedId);
        if (match) {
            setLastOpenedId(requestedId);
            setIsCreating(false);
            openDraft(draftFromMachine(match));
        }
    }

    // Holds in-app links and warns on tab close / reload while work is unsaved.
    useNavigationGuard(dirty, {
        title: "Leave without saving?",
        description: `“${draft.name.trim() || "This machine"}” has changes that have not been saved. Leaving this page discards them.`,
        confirmLabel: "Discard and leave",
        cancelLabel: "Stay on this page",
    });

    /** Set the draft *and* the baseline: this is the machine as the API has it. */
    function openDraft(next: MachineDraft) {
        setDraft(next);
        setBaselineDraft(next);
    }

    function openMachine(machine: MachineSummary) {
        setIsCreating(false);
        openDraft(draftFromMachine(machine));
    }

    function openNewMachine() {
        setReturnId(draft.id ?? returnId);
        setIsCreating(true);
        openDraft(EMPTY_MACHINE_DRAFT);
    }

    // Switching replaces the draft outright, so it is the same loss as
    // navigating away and gets the same question first. The list's selection
    // follows `draft.id`, so a held-back switch leaves it where it was.
    function selectMachine(id: string) {
        if (id === draft.id) return;
        const machine = machines.find((candidate) => candidate.id === id);
        if (!machine) return;
        if (dirty) setPendingOpen({ kind: "machine", machine });
        else openMachine(machine);
    }

    function startNewMachine() {
        if (dirty) setPendingOpen({ kind: "new" });
        else openNewMachine();
    }

    // Where cancelling a new machine lands: the one it was started from if
    // that still exists, otherwise nothing — the empty pane.
    const cancelTarget = machines.find((machine) => machine.id === returnId) ?? null;

    function leaveNewMachine(target: MachineSummary | null) {
        if (target) openMachine(target);
        else {
            setIsCreating(false);
            openDraft(EMPTY_MACHINE_DRAFT);
        }
    }

    function cancelNewMachine() {
        if (dirty) setPendingOpen({ kind: "cancel", machine: cancelTarget });
        else leaveNewMachine(cancelTarget);
    }

    async function save() {
        if (saving || !gate.canSave) return;
        const wasExisting = draft.id !== null;
        try {
            const saved = await saveMachine.mutateAsync(
                draft.id === null
                    ? { id: null, values: machineInputFromDraft(draft) }
                    // Status has its own button and is written as it is
                    // pressed, so a save never sends it: an edit opened before
                    // someone else deactivated the machine must not undo that.
                    : { id: draft.id, values: { ...machineInputFromDraft(draft), active: undefined } },
            );
            openMachine(saved);
            if (wasExisting) toast.success(`“${saved.name}” updated.`);
            else toast.success(`“${saved.name}” added to the floor.`, {
                description: "Its operator login was created with the default password. Manage it in Settings.",
            });
        } catch (error) {
            reportMutationError(error);
        }
    }

    /** Retire an active machine (confirmed first), or restore an inactive one. */
    function requestToggleActive() {
        if (!selected || saving) return;
        if (selected.active) setConfirmDeactivate(true);
        else void toggleActive();
    }

    async function toggleActive() {
        if (!selected || saving) return;
        try {
            const saved = await saveMachine.mutateAsync({ id: selected.id, values: { active: !selected.active } });
            setConfirmDeactivate(false);
            // Only the status was written. Unsaved edits to the other fields
            // stay on screen, still unsaved, rather than being thrown away.
            setBaselineDraft(draftFromMachine(saved));
            setDraft((previous) => ({ ...previous, active: saved.active }));
            toast.success(`“${saved.name}” ${saved.active ? "activated" : "deactivated"}.`);
        } catch (error) {
            setConfirmDeactivate(false);
            reportMutationError(error);
        }
    }

    function dismissRemove() {
        if (removeClosing) return;
        setRemoveClosing(true);
        setTimeout(() => {
            setConfirmRemove(false);
            setRemoveClosing(false);
        }, CLOSE_MS);
    }

    async function remove() {
        // A second press while the first delete is in flight would only 404.
        if (!selected || saving) return;
        const removedName = selected.name;
        try {
            await deleteMachine.mutateAsync(selected.id);
            setConfirmRemove(false);
            setIsCreating(false);
            openDraft(EMPTY_MACHINE_DRAFT);
            toast.success(`“${removedName}” removed from the floor.`);
        } catch (error) {
            setConfirmRemove(false);
            reportMutationError(error);
            // Most likely an operation was routed here since the jobs were
            // read; refresh them so the editor shows what is in the way.
            void jobDefinitionsQuery.refetch();
        }
    }

    /** Ctrl+S / ⌘S saves, exactly as pressing the button would. */
    useSaveShortcut(() => {
        // A dialog is a question waiting on an answer; saving behind it would
        // act on something the manager has already stepped away from.
        if (pendingOpen !== null || confirmDeactivate || confirmRemove || saving) return;
        if (gate.canSave) {
            void save();
            return;
        }
        if (gate.held && gate.reason !== null) toast.warning(gate.reason);
    });

    const loadError = machineQuery.error ?? categoryQuery.error;
    if (loadError instanceof ApiError && loadError.isForbidden) {
        return <ManagerPageState title="This needs a manager account">Machine administration is restricted to managers.</ManagerPageState>;
    }
    // A failed background refresh must not take the screen away: only a load
    // that never produced anything is a page-level error.
    if (loadError && (!machineQuery.data || !categoryQuery.data)) {
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
    if (machineQuery.isPending || categoryQuery.isPending) {
        return <ManagerPageState title="Loading machines…">Reading the floor inventory and categories from the API.</ManagerPageState>;
    }

    const notes = (
        <>
            {loadError && (
                <Note intent="warning" role="status">
                    Showing the last successful floor snapshot. Could not refresh: {errorMessage(loadError)}
                </Note>
            )}
            {jobDefinitionsQuery.error && !jobDefinitionsQuery.data && (
                <Note intent="warning" role="status">
                    Could not check which jobs use this machine: {errorMessage(jobDefinitionsQuery.error)}{" "}
                    Removal is still checked when you ask for it.
                </Note>
            )}
        </>
    );

    const openJobsOnSelected = selectedUsage?.jobs.filter((job) => job.backlogStatus === "open").length ?? 0;

    return (
        <ManagerShell paneScroll>
            <SidePaneLayout paneScroll>
                <SidePane id="machines.inventory" side="left" label="Machines" grow={0.8} minWidth={280} paneScroll>
                    <MachineInventoryPanel
                        total={machines.length}
                        activeCount={activeCount}
                        rows={visibleRows}
                        categories={filterCategories}
                        selectedId={draft.id}
                        filters={filters}
                        busy={saving}
                        onAddMachine={startNewMachine}
                        onFiltersChange={(update) => setFilters(update)}
                        onSelect={selectMachine}
                    />
                </SidePane>
                <SidePaneMain grow={2} paneScroll>
                    {selected === null && !isCreating ? (
                        // Same neutral empty pane the Schedules page shows: the
                        // screen opens with nothing selected, and the editor
                        // only appears once a machine is picked or added.
                        <Card className="min-h-full min-w-0">
                            <CardContent className="flex h-full flex-col items-center justify-center gap-4">
                                <PageMessage title={machines.length === 0 ? "No machines yet" : "No machine selected"} tone="info">
                                    <p>
                                        {machines.length === 0
                                            ? "Add a machine to the floor inventory to get started."
                                            : "Pick a machine in the inventory to view or edit it, or add a new one."}
                                    </p>
                                </PageMessage>
                                <Button onPress={startNewMachine} isDisabled={saving}>
                                    <PlusIcon /> New Machine
                                </Button>
                            </CardContent>
                        </Card>
                    ) : (
                        <MachineEditor
                        draft={draft}
                        selected={selected}
                        categories={draftCategories}
                        allCategories={categories}
                        saving={saving}
                        dirty={dirty}
                        gate={gate}
                        usage={selectedUsage}
                        notes={notes}
                        onDraftChange={(update) => setDraft(update)}
                        onSave={() => void save()}
                        onDiscard={() => setDraft(baselineDraft)}
                        onCancelNew={isCreating && (cancelTarget !== null || dirty) ? cancelNewMachine : undefined}
                        onToggleActive={requestToggleActive}
                        onRemove={() => setConfirmRemove(true)}
                        />
                    )}
                </SidePaneMain>
            </SidePaneLayout>

            {pendingOpen !== null && (
                <ConfirmDialog
                    title={pendingOpen.kind === "cancel" ? "Cancel this new machine?" : "Discard unsaved changes?"}
                    description={
                        pendingOpen.kind === "cancel"
                            ? `“${draft.name.trim() || "This new machine"}” has not been added yet. Cancelling throws it away.`
                            : pendingOpen.kind === "new"
                                ? `“${draft.name.trim() || "This machine"}” has changes that have not been saved. Adding a new machine discards them.`
                                : `“${draft.name.trim() || "This machine"}” has changes that have not been saved. Opening “${pendingOpen.machine.name}” discards them.`
                    }
                    confirmLabel={pendingOpen.kind === "cancel" ? "Discard machine" : "Discard changes"}
                    cancelLabel="Keep editing"
                    danger
                    onCancel={() => setPendingOpen(null)}
                    onConfirm={() => {
                        if (pendingOpen.kind === "new") openNewMachine();
                        else if (pendingOpen.kind === "cancel") leaveNewMachine(pendingOpen.machine);
                        else openMachine(pendingOpen.machine);
                        setPendingOpen(null);
                    }}
                />
            )}
            {confirmDeactivate && selected && (
                <ConfirmDialog
                    title={`Deactivate “${selected.name}”?`}
                    description={
                        openJobsOnSelected > 0
                            ? `${openJobsOnSelected} open ${openJobsOnSelected === 1 ? "job routes" : "jobs route"} work through this machine. It stays in their routes and in history, but the scheduler will stop planning work onto it.`
                            : "The machine and its existing operation routes stay in history, but it will be excluded from future scheduling."
                    }
                    confirmLabel="Deactivate machine"
                    danger
                    onConfirm={() => void toggleActive()}
                    onCancel={() => setConfirmDeactivate(false)}
                />
            )}
            {confirmRemove && selected && (
                <DeleteMachineDialog
                    machineName={selected.name}
                    closing={removeClosing}
                    onConfirm={() => void remove()}
                    onDismiss={dismissRemove}
                />
            )}
        </ManagerShell>
    );
}
