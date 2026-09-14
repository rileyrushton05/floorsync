"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { GridList, GridListEmptyState, GridListItem } from "@/components/ui/grid-list";
import { Input } from "@/components/ui/input";
import { Note } from "@/components/ui/note";
import { NumberField, NumberInput } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import {
    ArrowDownIcon,
    ArrowUpIcon,
    Bars2Icon,
    ChevronRightIcon,
    PlusIcon,
    XMarkIcon,
} from "@heroicons/react/24/outline";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useJobDefinitions, useCreateJobDefinition, useDeleteJobDefinition, useUpdateJobDefinition } from "@/features/jobs/data/queries";
import { useMachines } from "@/features/machines/data/queries";
import { priorityIntent } from "@/core/presentation/badge-intent";
import { errorMessage } from "@/core/http/errors";
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { buildJobColors, jobColor } from "@/domains/scheduling/colors";
import { formatDuration, totalWorkMins } from "@/domains/scheduling/format";
import type { JobDef, OperationDef } from "@/domains/scheduling/types";
import { DeleteJobDialog } from "@/features/jobs/ui/DeleteJobDialog";
import {
    DURATION_FILTERS,
    EMPTY_JOB_DRAFT,
    filterJobs,
    JOB_PRIORITIES,
    type JobDraft,
    SORT_OPTIONS,
    draftFromJob,
} from "@/features/jobs/model/editor";

/** How long the zoom-out runs before the dialog unmounts, in ms. */
const CLOSE_MS = 150;


export default function JobsPage() {
    return (
        <Suspense>
            <JobsPageInner />
        </Suspense>
    );
}

function JobsPageInner() {
    const machineQuery = useMachines();
    const jobQuery = useJobDefinitions();
    const createJob = useCreateJobDefinition();
    const updateJob = useUpdateJobDefinition();
    const deleteJob = useDeleteJobDefinition();
    const machines = useMemo(
        () =>
            (machineQuery.data ?? []).map((machine) => ({
                id: machine.id,
                name: machine.name,
                operator: "Unassigned",
                active: machine.active,
            })),
        [machineQuery.data],
    );
    const jobs = useMemo(() => jobQuery.data ?? [], [jobQuery.data]);
    const loading = machineQuery.isPending || jobQuery.isPending;
    const loadError = machineQuery.error ?? jobQuery.error;
    const saving = createJob.isPending || updateJob.isPending || deleteJob.isPending;
    const searchParams = useSearchParams();
    const [draft, setDraft] = useState<JobDraft>(() => (jobs.length > 0 ? draftFromJob(jobs[0]) : EMPTY_JOB_DRAFT));
    const [isCreating, setIsCreating] = useState(false);
    const [savedOrder, setSavedOrder] = useState<string[]>(() =>
        jobs.length > 0 ? jobs[0].operations.map((op) => op.id) : []
    );
    // Operations are only ever created by a click, so a plain counter is a safe
    // key source — no ids are generated during render.
    const opCounter = useRef(0);
    // Delete confirmation: open state plus a short "closing" window that keeps
    // the dialog mounted while the zoom-out animation plays.
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleteClosing, setDeleteClosing] = useState(false);
    // Drag-and-drop reordering of operations. `dragArmed` is set by pressing
    // the drag handle (so typing in the row's inputs never starts a drag);
    // `dragIndex` is the row being carried; `dropIndex` is where it would land;
    // `recentlyMoved` flashes the row that just landed.
    const [dragArmed, setDragArmed] = useState<number | null>(null);
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const [recentlyMoved, setRecentlyMoved] = useState<number | null>(null);
    // Operation order as last saved (or as opened). Rows whose current position
    // differs from this baseline stay highlighted light yellow until "Save
    // changes" commits the new order.
    // Backlog search / filter / sort state.
    const [query, setQuery] = useState("");
    const [priorityFilter, setPriorityFilter] = useState<(typeof JOB_PRIORITIES)[number]["id"] | "All">("All");
    const [machineFilter, setMachineFilter] = useState<string>("All");
    const [durationFilter, setDurationFilter] = useState<(typeof DURATION_FILTERS)[number]["id"]>("All");
    const [sortBy, setSortBy] = useState<(typeof SORT_OPTIONS)[number]["id"]>("Manual");

    // The floor definition arrives after authentication. Select its first job
    // only while the editor is pristine, so a delayed API response never
    // overwrites a new draft a manager has already started. This guarded render
    // update settles immediately, without a transient blank draft after load.
    if (jobs.length > 0 && !isCreating && draft.id === null && draft.name === "") {
        setDraft(draftFromJob(jobs[0]));
        setSavedOrder(jobs[0].operations.map((op) => op.id));
    }

    function dismissDelete() {
        if (deleteClosing) return;
        setDeleteClosing(true);
        setTimeout(() => {
            setConfirmingDelete(false);
            setDeleteClosing(false);
        }, CLOSE_MS);
    }

    // When routed here with a specific job (?job=<id>), open that job's draft
    // instead of defaulting to the first backlog job. Adjusting state during
    // render (guarded by lastOpenedJobId) avoids the render cascade of doing
    // it synchronously inside an effect.
    const requestedJobId = searchParams.get("job");
    const [lastOpenedJobId, setLastOpenedJobId] = useState(requestedJobId);
    if (requestedJobId && requestedJobId !== lastOpenedJobId) {
        const match = jobs.find((job) => job.id === requestedJobId);
        if (match) {
            setLastOpenedJobId(requestedJobId);
            setIsCreating(false);
            setDraft(draftFromJob(match));
            setSavedOrder(match.operations.map((op) => op.id));
        }
    }

    const colors = useMemo(() => buildJobColors(jobs), [jobs]);
    const activeMachines = machines.filter((machine) => machine.active);

    const filteredJobs = useMemo(
        () => filterJobs(jobs, { query, priority: priorityFilter, machineId: machineFilter, duration: durationFilter, sort: sortBy }),
        [jobs, query, priorityFilter, machineFilter, durationFilter, sortBy],
    );

    const filtersActive =
        query.trim() !== "" ||
        priorityFilter !== "All" ||
        machineFilter !== "All" ||
        durationFilter !== "All";

    function clearFilters() {
        setQuery("");
        setPriorityFilter("All");
        setMachineFilter("All");
        setDurationFilter("All");
    }

    const draftWorkMins = totalWorkMins(draft);
    const draftMachineIds = new Set(draft.operations.flatMap((operation) => operation.routes.map((route) => route.machineId)));

    function startNewJob() {
        setIsCreating(true);
        setDraft(EMPTY_JOB_DRAFT);
        setSavedOrder([]);
    }

    function editJob(job: JobDef) {
        setIsCreating(false);
        setDraft(draftFromJob(job));
        setSavedOrder(job.operations.map((op) => op.id));
    }

    function addOperation() {
        opCounter.current += 1;
        setDraft((previous) => ({
            ...previous,
            operations: [
                ...previous.operations,
                {
                    id: `new-op-${opCounter.current}`,
                    name: "",
                    routes: activeMachines[0]
                        ? [{ machineId: activeMachines[0].id, durationMins: 30, energy: null }]
                        : [],
                },
            ],
        }));
        // Keep the baseline aligned so only true reorderings flag yellow.
        setSavedOrder((previous) => [...previous, `new-op-${opCounter.current}`]);
    }

    function patchOperation(index: number, patch: Partial<Pick<OperationDef, "name">>) {
        setDraft((previous) => ({
            ...previous,
            operations: previous.operations.map((op, i) => (i === index ? { ...op, ...patch } : op)),
        }));
    }

    function patchRoute(
        operationIndex: number,
        routeIndex: number,
        patch: Partial<OperationDef["routes"][number]>,
    ) {
        setDraft((previous) => ({
            ...previous,
            operations: previous.operations.map((operation, index) => {
                if (index !== operationIndex) return operation;
                const routes = operation.routes.map((route, currentRouteIndex) =>
                    currentRouteIndex === routeIndex ? { ...route, ...patch } : route,
                );
                return { ...operation, routes };
            }),
        }));
    }

    function addRoute(operationIndex: number) {
        setDraft((previous) => ({
            ...previous,
            operations: previous.operations.map((operation, index) => {
                if (index !== operationIndex) return operation;
                const routes = operation.routes;
                const machine = activeMachines.find(
                    (candidate) => !routes.some((route) => route.machineId === candidate.id),
                );
                if (!machine) return operation;
                return {
                    ...operation,
                    routes: [
                    ...routes,
                    { machineId: machine.id, durationMins: 30, energy: null },
                    ],
                };
            }),
        }));
    }

    function removeRoute(operationIndex: number, routeIndex: number) {
        setDraft((previous) => ({
            ...previous,
            operations: previous.operations.map((operation, index) => {
                if (index !== operationIndex) return operation;
                return { ...operation, routes: operation.routes.filter((_, current) => current !== routeIndex) };
            }),
        }));
    }

    function removeOperation(index: number) {
        setDraft((previous) => ({
            ...previous,
            operations: previous.operations.filter((_, i) => i !== index),
        }));
        // Close the same gap in the baseline so surviving rows keep their
        // original relative positions (and don't falsely flag as reordered).
        setSavedOrder((previous) => {
            const removed = draft.operations[index]?.id;
            return removed ? previous.filter((id) => id !== removed) : previous;
        });
    }

    /** Reordering matters: operations run in array order, so this edits precedence. */
    function moveOperation(index: number, offset: number) {
        const target = index + offset;
        setDraft((previous) => {
            if (target < 0 || target >= previous.operations.length) return previous;
            const operations = [...previous.operations];
            [operations[index], operations[target]] = [operations[target], operations[index]];
            return { ...previous, operations };
        });
        flashMoved(target);
    }

    function flashMoved(index: number) {
        setRecentlyMoved(index);
        setTimeout(() => setRecentlyMoved((current) => (current === index ? null : current)), 900);
    }

    /** Insert the dragged row at `to`, shifting the others down. */
    function reorderOperation(from: number, to: number) {
        setDraft((previous) => {
            if (from === to || from < 0 || to < 0 || from >= previous.operations.length) return previous;
            const operations = [...previous.operations];
            const [moved] = operations.splice(from, 1);
            operations.splice(to, 0, moved);
            return { ...previous, operations };
        });
        flashMoved(to);
    }

    function resetDrag() {
        setDragArmed(null);
        setDragIndex(null);
        setDropIndex(null);
    }

    async function saveDraft() {
        try {
            const saved = draft.id
                ? await updateJob.mutateAsync({ id: draft.id, job: draft })
                : await createJob.mutateAsync(draft);
            setDraft(draftFromJob(saved));
            if (draft.id) {
                toast.success(`${saved.id} definition saved.`);
            } else {
                setIsCreating(false);
                toast.success(`${saved.id} created in the backlog.`);
            }
            setSavedOrder(saved.operations.map((op) => op.id));
        } catch (error) {
            reportMutationError(error);
        }
    }

    async function removeJob() {
        if (!draft.id) return;
        const removedId = draft.id;
        try {
            await deleteJob.mutateAsync(removedId);
            setIsCreating(false);
            setDraft(EMPTY_JOB_DRAFT);
            setConfirmingDelete(false);
            setDeleteClosing(false);
            toast.success(`${removedId} deleted.`);
        } catch (error) {
            reportMutationError(error);
            setConfirmingDelete(false);
            setDeleteClosing(false);
        }
    }

    return (
        <ManagerShell actions={<Button onPress={startNewJob} isDisabled={loading || saving}><PlusIcon /> New job</Button>}>

            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(280px,0.8fr)_2fr]">
                <Card>
                    <CardHeader className="flex-row items-center gap-2.5">
                        <CardTitle>Job backlog</CardTitle>
                        <Badge intent="secondary">Total Jobs: ( {jobs.length} )</Badge>
                    </CardHeader>
                    <CardContent>
                        <TextField aria-label="Search jobs" value={query} onChange={setQuery}>
                            <Input placeholder="Search by job id or name…" autoComplete="off" />
                        </TextField>

                        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-muted-fg text-xs uppercase tracking-[0.05em]">
                                Filter
                            </span>
                            {filtersActive && (
                                <Button intent="plain" size="sm" onPress={clearFilters}>
                                    <XMarkIcon /> Clear
                                </Button>
                            )}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Select
                                aria-label="Filter by priority"
                                className="w-36"
                                value={priorityFilter}
                                onChange={(value) => setPriorityFilter(value as typeof priorityFilter)}
                            >
                                <SelectTrigger />
                                <SelectContent>
                                    <SelectItem id="All" textValue="All">All priorities</SelectItem>
                                    {JOB_PRIORITIES.map((option) => (
                                        <SelectItem key={option.id} id={option.id} textValue={option.id}>
                                            {option.id}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            <Select
                                aria-label="Filter by machine"
                                className="w-42"
                                value={machineFilter}
                                onChange={(value) => setMachineFilter(String(value))}
                            >
                                <SelectTrigger />
                                <SelectContent>
                                    <SelectItem id="All" textValue="All">Any machine</SelectItem>
                                    {machines.map((machine) => (
                                        <SelectItem key={machine.id} id={machine.id} textValue={machine.name}>
                                            {machine.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            <Select
                                aria-label="Filter by duration"
                                className="w-44"
                                value={durationFilter}
                                onChange={(value) => setDurationFilter(value as typeof durationFilter)}
                            >
                                <SelectTrigger />
                                <SelectContent>
                                    {DURATION_FILTERS.map((option) => (
                                        <SelectItem key={option.id} id={option.id} textValue={option.label}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                        </div>

                        <Separator className="my-5" />

                        <div className="mb-4 flex flex-wrap items-center gap-2">
                            <span className="font-medium text-muted-fg text-xs">Sort:</span>
                            <Select
                                aria-label="Sort jobs"
                                className="w-40"
                                value={sortBy}
                                onChange={(value) => setSortBy(value as typeof sortBy)}
                            >
                                <SelectTrigger />
                                <SelectContent>
                                    {SORT_OPTIONS.map((option) => (
                                        <SelectItem key={option.id} id={option.id} textValue={option.label}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <span className="ml-auto font-medium text-muted-fg text-xs" role="status">
                                Showing {filteredJobs.length} of {jobs.length} job{jobs.length === 1 ? "" : "s"}
                            </span>
                        </div>

                        <GridList
                            aria-label="Job backlog"
                            selectionMode="single"
                            selectionBehavior="replace"
                            items={filteredJobs}
                            selectedKeys={draft.id ? new Set([draft.id]) : new Set()}
                            onSelectionChange={(keys) => {
                                if (keys === "all") return;
                                const [first] = Array.from(keys);
                                const job = filteredJobs.find((candidate) => candidate.id === first);
                                if (job) editJob(job);
                            }}
                            renderEmptyState={() => (
                                <GridListEmptyState>
                                    {filtersActive
                                        ? "No jobs match your search or filters."
                                        : "No jobs yet. Create one to get started."}
                                </GridListEmptyState>
                            )}
                        >
                            {(job) => (
                                <GridListItem
                                    id={job.id}
                                    textValue={`${job.id} ${job.name}`}
                                    className="items-start hover:bg-secondary! hover:text-fg! dark:hover:bg-secondary! selected:bg-primary/25! selected:text-fg! dark:selected:bg-primary/25! selected:hover:bg-primary/35! dark:selected:hover:bg-primary/35!"
                                >
                                    <span
                                        className="mt-1 size-3 shrink-0 rounded-full"
                                        style={{ background: jobColor(colors, job.id).fill }}
                                    />
                                    <span className="flex min-w-0 flex-col gap-0.5">
                                        <span className="flex items-center gap-2">
                                            <span className="font-semibold text-sm">{job.id}</span>
                                            <Badge intent={priorityIntent(job.priority)}>{job.priority}</Badge>
                                        </span>
                                        <span className="truncate text-sm">{job.name}</span>
                                        <span className="text-muted-fg text-xs selected:text-muted-fg!">
                                            {job.operations.length} ops · {formatDuration(totalWorkMins(job))} of work
                                        </span>
                                    </span>
                                    <ChevronRightIcon
                                        aria-label={`Open ${job.id} details`}
                                        className="ml-auto size-4 shrink-0 text-muted-fg transition group-hover:translate-x-0.5 group-hover:text-fg selected:text-fg"
                                    />
                                </GridListItem>
                            )}
                        </GridList>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex-row items-center justify-between gap-3">
                        <CardTitle>{draft.id ? `Edit ${draft.id}` : "New job"}</CardTitle>
                        {draft.id && (
                            <span className="text-muted-fg text-sm">{draft.operations.length} operations</span>
                        )}
                    </CardHeader>
                    <CardContent className="space-y-5">
                        {loading && (
                            <Note intent="info" role="status">
                                Loading the job backlog and machines from the API…
                            </Note>
                        )}

                        {loadError && !jobQuery.data && !machineQuery.data && (
                            <Note intent="danger" role="alert">
                                <strong>Could not load the job backlog.</strong>
                                <div className="mt-1">{errorMessage(loadError)}</div>
                            </Note>
                        )}

                        {!loading && loadError && (jobQuery.data || machineQuery.data) && (
                            <Note intent="warning" role="status">
                                Showing the last successful floor snapshot. Could not refresh: {errorMessage(loadError)}
                            </Note>
                        )}

                        {!loading && !loadError && (
                            <Note intent="info">
                                <strong>Job definitions are saved to the API.</strong> Saving writes the name,
                                priority, ordered operations, and their machine routes as one atomic change.
                            </Note>
                        )}

                        <div className="flex flex-col gap-4 sm:flex-row">
                            <TextField
                                className="flex-2"
                                value={draft.name}
                                onChange={(name) => setDraft((previous) => ({ ...previous, name }))}
                            >
                                <Label>Job name</Label>
                                <Input placeholder="e.g. Dryer not working" />
                            </TextField>

                            <Select
                                className="flex-1"
                                value={draft.priority}
                                onChange={(priority) =>
                                    setDraft((previous) => ({ ...previous, priority: priority as JobDraft["priority"] }))
                                }
                            >
                                <Label>Priority</Label>
                                <SelectTrigger />
                                <SelectContent items={JOB_PRIORITIES}>
                                    {(item) => (
                                        <SelectItem id={item.id} textValue={item.id}>
                                            {item.id}
                                        </SelectItem>
                                    )}
                                </SelectContent>
                            </Select>
                        </div>

                        <div>
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <h3 className="font-semibold text-sm">Operations</h3>
                                <span className="flex items-center gap-1 text-muted-fg text-xs">
                                    <Bars2Icon className="size-3.5" />
                                    Run top to bottom — drag the handle to reorder
                                </span>
                            </div>

                            <ol className="mt-3 space-y-1">
                                {draft.operations.map((op, index) => {
                                    const total = draft.operations.length;
                                    // Sequence colour: the first step is green, the last
                                    // red, the middle ones yellow — the same light the
                                    // scheduler uses for done / upcoming / blocked.
                                    const step =
                                        total <= 1 ? "primary" : index === 0 ? "first" : index === total - 1 ? "last" : "middle";
                                    const STEP_STYLE: Record<string, string> = {
                                        first: "border-success bg-success text-success-fg",
                                        middle: "border-warning bg-warning text-warning-fg",
                                        last: "border-danger bg-danger text-danger-fg",
                                        primary: "border-primary bg-primary text-primary-fg",
                                    };
                                    const STEP_LABEL: Record<string, string> = {
                                        first: "starts the job",
                                        middle: "step",
                                        last: "finishes the job",
                                        primary: "only step",
                                    };
                                    const isDragging = dragIndex === index;
                                    // The dragged row would land here if released now.
                                    const dropBefore = dragIndex !== null && dropIndex === index && dropIndex !== dragIndex;
                                    const dropAfter =
                                        dragIndex !== null && dropIndex === total && dropIndex !== dragIndex && index === total - 1;
                                    const landing = recentlyMoved === index;
                                    // Rows whose position differs from the last-saved order
                                    // stay light yellow until the draft is saved.
                                    const reordered = savedOrder[index] !== op.id;
                                    const routes = op.routes;
                                    const canAddRoute = activeMachines.some(
                                        (machine) => !routes.some((route) => route.machineId === machine.id),
                                    );
                                    return (
                                        <li
                                            key={op.id}
                                            draggable={dragArmed === index}
                                            onDragStart={(event) => {
                                                setDragIndex(index);
                                                event.dataTransfer.effectAllowed = "move";
                                                event.dataTransfer.setData("text/plain", String(index));
                                            }}
                                            onDragOver={(event) => {
                                                if (dragIndex === null) return;
                                                event.preventDefault();
                                                event.dataTransfer.dropEffect = "move";
                                                // Which half of the row the pointer is over decides
                                                // whether the drop lands above or below it.
                                                const bounds = event.currentTarget.getBoundingClientRect();
                                                const after = event.clientY > bounds.top + bounds.height / 2;
                                                setDropIndex(Math.min(index + (after ? 1 : 0), total));
                                            }}
                                            onDrop={(event) => {
                                                event.preventDefault();
                                                if (dragIndex !== null && dropIndex !== null) {
                                                    reorderOperation(dragIndex, dragIndex < dropIndex ? dropIndex - 1 : dropIndex);
                                                }
                                                resetDrag();
                                            }}
                                            onDragEnd={resetDrag}
                                            className={`grid items-end gap-2.5 rounded-lg border p-2.5 transition-colors sm:grid-cols-[auto_1fr_auto] ${reordered ? "border-warning/50 bg-warning-subtle/60" : "border-border bg-muted"
                                                } ${isDragging ? "opacity-40" : ""
                                                } ${landing ? "ring-2 ring-primary" : ""} ${dropBefore
                                                    ? "border-t-primary border-t-2"
                                                    : dropAfter
                                                        ? "border-b-primary border-b-2"
                                                        : ""
                                                }`}
                                        >
                                            <span className="flex items-center gap-1 self-center">
                                                <Button
                                                    intent="plain"
                                                    size="sq-xs"
                                                    className="cursor-grab active:cursor-grabbing"
                                                    onPointerDown={() => setDragArmed(index)}
                                                    onPointerUp={resetDrag}
                                                    aria-label={`Reorder operation ${index + 1}`}
                                                >
                                                    <Bars2Icon />
                                                </Button>
                                                <span
                                                    className={`flex size-6 shrink-0 items-center justify-center rounded-full border font-semibold text-xs ${STEP_STYLE[step]}`}
                                                    title={`Operation ${index + 1} of ${total} — ${STEP_LABEL[step]}`}
                                                >
                                                    {index + 1}
                                                </span>
                                            </span>

                                            <TextField
                                                aria-label={`Operation ${index + 1} name`}
                                                value={op.name}
                                                onChange={(name) => patchOperation(index, { name })}
                                            >
                                                <Input placeholder="Operation name" />
                                            </TextField>

                                            <span className="flex items-center gap-1 self-center">
                                                <Button
                                                    intent="plain"
                                                    size="sq-xs"
                                                    onPress={() => moveOperation(index, -1)}
                                                    isDisabled={index === 0}
                                                    aria-label={`Move operation ${index + 1} earlier`}
                                                >
                                                    <ArrowUpIcon />
                                                </Button>
                                                <Button
                                                    intent="plain"
                                                    size="sq-xs"
                                                    onPress={() => moveOperation(index, 1)}
                                                    isDisabled={index === draft.operations.length - 1}
                                                    aria-label={`Move operation ${index + 1} later`}
                                                >
                                                    <ArrowDownIcon />
                                                </Button>
                                                <Button
                                                    intent="plain"
                                                    size="sq-xs"
                                                    onPress={() => removeOperation(index)}
                                                    aria-label={`Remove operation ${index + 1}`}
                                                >
                                                    <XMarkIcon />
                                                </Button>
                                            </span>

                                            <div className="col-span-full rounded-md border bg-overlay p-2.5">
                                                <div className="mb-2 flex items-center justify-between gap-2">
                                                    <span className="font-medium text-muted-fg text-xs">Compatible machine routes</span>
                                                    <Button
                                                        intent="outline"
                                                        size="sm"
                                                        onPress={() => addRoute(index)}
                                                        isDisabled={saving || !canAddRoute}
                                                    >
                                                        <PlusIcon /> Add route
                                                    </Button>
                                                </div>
                                                <div className="space-y-2">
                                                    {routes.map((route, routeIndex) => {
                                                        const currentMachine = machines.find(
                                                            (machine) => machine.id === route.machineId,
                                                        );
                                                        return (
                                                            <div
                                                                key={`${route.machineId}-${routeIndex}`}
                                                                className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_9rem_9rem_auto]"
                                                            >
                                                                <Select
                                                                    aria-label={`Operation ${index + 1}, route ${routeIndex + 1} machine`}
                                                                    value={route.machineId}
                                                                    onChange={(machineId) =>
                                                                        patchRoute(index, routeIndex, { machineId: String(machineId) })
                                                                    }
                                                                >
                                                                    <SelectTrigger />
                                                                    <SelectContent>
                                                                        {activeMachines.map((machine) => (
                                                                            <SelectItem
                                                                                key={machine.id}
                                                                                id={machine.id}
                                                                                textValue={machine.name}
                                                                                isDisabled={routes.some(
                                                                                    (existing, existingIndex) =>
                                                                                        existingIndex !== routeIndex && existing.machineId === machine.id,
                                                                                )}
                                                                            >
                                                                                {machine.name}
                                                                            </SelectItem>
                                                                        ))}
                                                                        {currentMachine && !currentMachine.active && (
                                                                            <SelectItem
                                                                                id={currentMachine.id}
                                                                                textValue={`${currentMachine.name} (inactive)`}
                                                                                isDisabled
                                                                            >
                                                                                {currentMachine.name} (inactive)
                                                                            </SelectItem>
                                                                        )}
                                                                    </SelectContent>
                                                                </Select>

                                                                <NumberField
                                                                    aria-label={`Operation ${index + 1}, route ${routeIndex + 1} duration in minutes`}
                                                                    minValue={1}
                                                                    step={1}
                                                                    formatOptions={{ maximumFractionDigits: 0 }}
                                                                    value={route.durationMins}
                                                                    onChange={(durationMins) =>
                                                                        patchRoute(index, routeIndex, { durationMins: Math.round(durationMins) })
                                                                    }
                                                                >
                                                                    <NumberInput placeholder="Minutes" />
                                                                </NumberField>

                                                                <NumberField
                                                                    aria-label={`Operation ${index + 1}, route ${routeIndex + 1} energy`}
                                                                    minValue={0}
                                                                    step={0.1}
                                                                    value={route.energy === null ? undefined : Number(route.energy)}
                                                                    onChange={(energy) =>
                                                                        patchRoute(index, routeIndex, {
                                                                            energy: energy === null ? null : String(energy),
                                                                        })
                                                                    }
                                                                >
                                                                    <NumberInput placeholder="Energy (optional)" />
                                                                </NumberField>

                                                                <Button
                                                                    intent="plain"
                                                                    size="sq-xs"
                                                                    onPress={() => removeRoute(index, routeIndex)}
                                                                    isDisabled={saving || routes.length === 1}
                                                                    aria-label={`Remove route ${routeIndex + 1} from operation ${index + 1}`}
                                                                >
                                                                    <XMarkIcon />
                                                                </Button>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                                {draft.operations.length === 0 && (
                                    <li className="rounded-lg border border-dashed p-4 text-center text-muted-fg text-sm">
                                        No operations yet — a job needs at least one.
                                    </li>
                                )}
                            </ol>

                            <Button
                                intent="outline"
                                size="sm"
                                className="mt-3"
                                onPress={addOperation}
                                isDisabled={saving || loading || Boolean(loadError) || activeMachines.length === 0}
                            >
                                <PlusIcon /> Add operation
                            </Button>
                        </div>

                        <Separator />

                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="text-muted-fg text-sm">
                                {draft.operations.length} operations · {formatDuration(draftWorkMins)} on first listed routes ·{" "}
                                {draftMachineIds.size} compatible machines
                            </div>
                            <div className="flex items-center gap-2.5">
                                {draft.id && (
                                    <Button
                                        intent="danger"
                                        onPress={() => setConfirmingDelete(true)}
                                        isDisabled={saving || loading || Boolean(loadError)}
                                    >
                                        Delete job
                                    </Button>
                                )}
                                <Button onPress={saveDraft} isDisabled={saving || loading || Boolean(loadError)}>
                                    {saving ? "Saving…" : draft.id ? "Save changes" : "Create job"}
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </main>

            {confirmingDelete && draft.id && (
                <DeleteJobDialog
                    jobId={draft.id}
                    closing={deleteClosing}
                    onConfirm={removeJob}
                    onDismiss={dismissDelete}
                />
            )}
        </ManagerShell>
    );
}
