"use client";

import { useAuth } from "@/app/_components/AuthProvider";
import {
    ApiError,
    type CursorPage,
    type MachineCategory,
    type MachineInput,
    type MachineSummary,
    createMachine,
    fetchMachineCategories,
    fetchMachines,
    updateMachine,
} from "@/app/_lib/api";
import { errorMessage, type LoadState } from "@/app/_lib/load-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Note } from "@/components/ui/note";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { CheckIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ManagerTopbar } from "../_components/ManagerTopbar";

interface MachineData {
    machines: MachineSummary[];
    categories: MachineCategory[];
}

interface Draft {
    id: string | null;
    name: string;
    categoryId: string | null;
    salary: string;
    active: boolean;
}

const EMPTY_DRAFT: Draft = { id: null, name: "", categoryId: null, salary: "", active: true };
const NO_CATEGORY = "__none";

async function fetchEveryPage<Item>(
    readPage: (cursor?: string) => Promise<CursorPage<Item>>,
): Promise<Item[]> {
    const all: Item[] = [];
    let cursor: string | undefined;
    do {
        const page = await readPage(cursor);
        all.push(...page.items);
        cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return all;
}

function draftFrom(machine: MachineSummary): Draft {
    return {
        id: machine.id,
        name: machine.name,
        categoryId: machine.category_id,
        salary: machine.salary ?? "",
        active: machine.active,
    };
}

function inputFrom(draft: Draft): MachineInput {
    return {
        name: draft.name.trim(),
        category_id: draft.categoryId,
        salary: draft.salary.trim() === "" ? null : draft.salary.trim(),
        active: draft.active,
    };
}

function isValidSalary(value: string): boolean {
    if (value.trim() === "") return true;
    const salary = Number(value);
    return Number.isFinite(salary) && salary >= 0;
}

export default function MachinesPage() {
    const { token } = useAuth();
    const [data, setData] = useState<LoadState<MachineData>>({ status: "loading" });
    const [attempt, setAttempt] = useState(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
    const [saving, setSaving] = useState(false);
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

    useEffect(() => {
        if (token === null) return;
        let current = true;
        void Promise.all([
            fetchEveryPage((cursor) => fetchMachines(token, 100, cursor)),
            fetchMachineCategories(token),
        ])
            .then(([machines, categories]) => {
                if (!current) return;
                setData({ status: "ready", value: { machines, categories } });
            })
            .catch((error: unknown) => {
                if (!current) return;
                if (error instanceof ApiError && error.isForbidden) {
                    setData({ status: "forbidden" });
                    return;
                }
                setData({ status: "error", message: errorMessage(error) });
            });
        return () => {
            current = false;
        };
    }, [attempt, token]);

    const machines = useMemo(() => (data.status === "ready" ? data.value.machines : []), [data]);
    const categories = useMemo(() => (data.status === "ready" ? data.value.categories : []), [data]);
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

    const beginCreate = useCallback(() => {
        setSelectedId(null);
        setDraft(EMPTY_DRAFT);
    }, []);

    const selectMachine = useCallback((machine: MachineSummary) => {
        setSelectedId(machine.id);
        setDraft(draftFrom(machine));
    }, []);

    async function save() {
        if (token === null || saving) return;
        if (draft.name.trim() === "") {
            toast.error("Give the machine a name.");
            return;
        }
        if (!isValidSalary(draft.salary)) {
            toast.error("Salary must be a non-negative number.");
            return;
        }

        setSaving(true);
        try {
            const saved = draft.id
                ? await updateMachine(draft.id, inputFrom(draft), token)
                : await createMachine(inputFrom(draft), token);
            setData((previous) => {
                if (previous.status !== "ready") return previous;
                const exists = previous.value.machines.some((machine) => machine.id === saved.id);
                return {
                    status: "ready",
                    value: {
                        ...previous.value,
                        machines: exists
                            ? previous.value.machines.map((machine) => (machine.id === saved.id ? saved : machine))
                            : [...previous.value.machines, saved].sort((left, right) => left.name.localeCompare(right.name)),
                    },
                };
            });
            setSelectedId(saved.id);
            setDraft(draftFrom(saved));
            toast.success(draft.id ? `${saved.name} updated.` : `${saved.name} added to the floor.`);
        } catch (error) {
            toast.error(errorMessage(error));
        } finally {
            setSaving(false);
        }
    }

    async function deactivate() {
        if (!selected || token === null || saving) return;
        setSaving(true);
        try {
            const saved = await updateMachine(selected.id, { active: false }, token);
            setData((previous) =>
                previous.status === "ready"
                    ? {
                        status: "ready",
                        value: {
                            ...previous.value,
                            machines: previous.value.machines.map((machine) =>
                                machine.id === saved.id ? saved : machine,
                            ),
                        },
                    }
                    : previous,
            );
            setDraft(draftFrom(saved));
            toast.success(`${saved.name} deactivated.`);
        } catch (error) {
            toast.error(errorMessage(error));
        } finally {
            setSaving(false);
        }
    }

    if (data.status === "loading") {
        return <PageState title="Loading machines…">Reading the floor inventory and categories from the API.</PageState>;
    }
    if (data.status === "forbidden") {
        return <PageState title="This needs a manager account">Machine administration is restricted to managers.</PageState>;
    }
    if (data.status === "error") {
        return (
            <PageState title="Could not load machines" error>
                <p>{data.message}</p>
                <Button intent="outline" size="sm" className="mt-3" onPress={() => setAttempt((value) => value + 1)}>
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
                        <ul className="mt-5 space-y-2">
                            {filteredMachines.map((machine) => (
                                <li key={machine.id}>
                                    <Button
                                        intent={machine.id === selectedId ? "primary" : "outline"}
                                        className="h-auto w-full justify-start px-3 py-2.5 text-left"
                                        onPress={() => selectMachine(machine)}
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-semibold">{machine.name}</span>
                                            <span className="block truncate text-xs opacity-75">{machine.id}</span>
                                        </span>
                                        <Badge intent={machine.active ? "success" : "secondary"}>
                                            {machine.active ? "Active" : "Inactive"}
                                        </Badge>
                                    </Button>
                                </li>
                            ))}
                        </ul>
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
