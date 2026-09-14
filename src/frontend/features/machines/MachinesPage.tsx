"use client";

import { ApiError, type MachineSummary } from "@/app/_lib/api";
import { errorMessage } from "@/app/_lib/errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Note } from "@/components/ui/note";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { CheckIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
    EMPTY_MACHINE_DRAFT,
    draftFromMachine,
    isValidMachineSalary,
    machineInputFromDraft,
    toMachineRow,
    type MachineDraft,
} from "@/features/machines/model";
import { useMachineCategories, useMachines, useSaveMachine } from "@/features/machines/queries";
import { MachineInventoryList } from "@/features/machines/ui/MachineInventoryList";
import { ManagerTopbar } from "@/app/manager/_components/ManagerTopbar";
const NO_CATEGORY = "__none";

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
        return <PageState title="Loading machines…">Reading the floor inventory and categories from the API.</PageState>;
    }
    const loadError = machineQuery.error ?? categoryQuery.error;
    if (loadError instanceof ApiError && loadError.isForbidden) {
        return <PageState title="This needs a manager account">Machine administration is restricted to managers.</PageState>;
    }
    if (loadError) {
        return (
            <PageState title="Could not load machines" error>
                <p>{errorMessage(loadError)}</p>
                <Button
                    intent="outline"
                    size="sm"
                    className="mt-3"
                    onPress={() => void Promise.all([machineQuery.refetch(), categoryQuery.refetch()])}
                >
                    Try again
                </Button>
            </PageState>
        );
    }

    return (
        <div className="flex min-h-dvh flex-col bg-bg text-fg">
            <ManagerTopbar>
                <Button onPress={beginCreate} isDisabled={saving}>
                    <PlusIcon /> Add machine
                </Button>
            </ManagerTopbar>

            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(280px,0.8fr)_2fr]">
                <Card>
                    <CardHeader className="flex-row items-center justify-between gap-3">
                        <CardTitle>Machine inventory</CardTitle>
                        <Badge intent="secondary">{machines.length}</Badge>
                    </CardHeader>
                    <CardContent>
                        <TextField aria-label="Search machines" value={query} onChange={setQuery}>
                            <Input placeholder="Search name or ID…" autoComplete="off" />
                        </TextField>
                        <Select
                            aria-label="Filter machine status"
                            className="mt-3"
                            value={statusFilter}
                            onChange={(value) => setStatusFilter(value as typeof statusFilter)}
                        >
                            <Label>Status</Label>
                            <SelectTrigger />
                            <SelectContent>
                                <SelectItem id="all">All machines</SelectItem>
                                <SelectItem id="active">Active</SelectItem>
                                <SelectItem id="inactive">Inactive</SelectItem>
                            </SelectContent>
                        </Select>
                        <MachineInventoryList
                            rows={filteredRows}
                            selectedId={selectedId}
                            onSelect={(id) => {
                                const machine = machines.find((candidate) => candidate.id === id);
                                if (machine) selectMachine(machine);
                            }}
                        />
                        {filteredMachines.length === 0 && (
                            <p className="py-6 text-center text-muted-fg text-sm">No machines match these filters.</p>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader><CardTitle>{draft.id ? "Edit machine" : "Add machine"}</CardTitle></CardHeader>
                    <CardContent className="max-w-xl space-y-5">
                        <Note intent="info">
                            This screen shows only fields stored by the machine API. A machine is retired by setting it inactive; the API intentionally does not delete machine history.
                        </Note>
                        <TextField value={draft.name} onChange={(name) => setDraft((value) => ({ ...value, name }))}>
                            <Label>Machine name</Label>
                            <Input placeholder="e.g. Assembly station 2" autoComplete="off" />
                        </TextField>
                        <Select
                            value={draft.categoryId ?? NO_CATEGORY}
                            onChange={(value) => setDraft((draftValue) => ({
                                ...draftValue,
                                categoryId: value === NO_CATEGORY ? null : String(value),
                            }))}
                        >
                            <Label>Category</Label>
                            <SelectTrigger />
                            <SelectContent>
                                <SelectItem id={NO_CATEGORY}>No category</SelectItem>
                                {categories.map((category) => (
                                    <SelectItem key={category.id} id={category.id} textValue={category.name}>{category.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <TextField value={draft.salary} onChange={(salary) => setDraft((value) => ({ ...value, salary }))}>
                            <Label>Hourly salary</Label>
                            <Input inputMode="decimal" placeholder="Optional" />
                        </TextField>
                        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                            <div>
                                <p className="font-medium text-sm">Available to the scheduler</p>
                                <p className="text-muted-fg text-xs">Inactive machines are kept as history but excluded from scheduling.</p>
                            </div>
                            <Button
                                intent={draft.active ? "success" : "outline"}
                                size="sm"
                                onPress={() => setDraft((value) => ({ ...value, active: !value.active }))}
                            >
                                {draft.active ? "Active" : "Inactive"}
                            </Button>
                        </div>
                        {draft.id && (
                            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-4 text-sm">
                                <dt className="text-muted-fg">ID</dt><dd className="break-all">{draft.id}</dd>
                                <dt className="text-muted-fg">Created</dt><dd>{new Date(selected?.created_at ?? "").toLocaleString()}</dd>
                                <dt className="text-muted-fg">Category</dt><dd>{draft.categoryId ? categoryName.get(draft.categoryId) ?? draft.categoryId : "None"}</dd>
                            </dl>
                        )}
                        <div className="flex flex-wrap justify-between gap-3 border-t pt-5">
                            {selected?.active && draft.id === selected.id ? (
                                <Button intent="danger" onPress={deactivate} isDisabled={saving}>Deactivate</Button>
                            ) : <span />}
                            <Button onPress={save} isPending={saving}>
                                <CheckIcon /> {draft.id ? "Save changes" : "Add machine"}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </main>
        </div>
    );
}

function PageState({ title, children, error = false }: { title: string; children: React.ReactNode; error?: boolean }) {
    return (
        <div className="flex min-h-dvh flex-col bg-bg text-fg">
            <ManagerTopbar />
            <main className="flex flex-1 items-center justify-center p-5">
                <Note intent={error ? "danger" : "info"} className="max-w-lg">
                    <strong>{title}</strong><div className="mt-1 text-sm">{children}</div>
                </Note>
            </main>
        </div>
    );
}
