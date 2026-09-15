"use client";

import { Button } from "@/components/ui/button";
import { Note } from "@/components/ui/note";
import { errorMessage } from "@/core/http/errors";
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { buildJobColors } from "@/domains/scheduling/colors";
import type { JobDef, OperationDef } from "@/domains/scheduling/types";
import {
    useCreateJobDefinition,
    useDeleteJobDefinition,
    useJobDefinitions,
    useUpdateJobDefinition,
} from "@/features/jobs/data/queries";
import { useMachines } from "@/features/machines/data/queries";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DeleteJobDialog } from "@/features/jobs/ui/DeleteJobDialog";
import { JobBacklogPanel } from "@/features/jobs/ui/JobBacklogPanel";
import { JobEditorPanel } from "@/features/jobs/ui/JobEditorPanel";
import type { RowDragState } from "@/features/jobs/ui/OperationEditor";
import {
    DEFAULT_SORT,
    EMPTY_JOB_DRAFT,
    draftFromJob,
    filterJobs,
    jobSequenceNumbers,
    type JobDraft,
    type JobFilters,
} from "@/features/jobs/model/editor";

/** How long the zoom-out runs before the dialog unmounts, in ms. */
const CLOSE_MS = 150;

const INITIAL_FILTERS: JobFilters = {
    query: "",
    priority: "All",
    machineId: "All",
    duration: "All",
    sort: DEFAULT_SORT,
};

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
    const [filters, setFilters] = useState<JobFilters>(INITIAL_FILTERS);

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
    // instead of defaulting to the first backlog job. The id stays in the URL
    // because it is the only stable handle another screen can link by; it is
    // never rendered. Adjusting state during render (guarded by
    // lastOpenedJobId) avoids the render cascade of doing it inside an effect.
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
    const sequenceNumbers = useMemo(() => jobSequenceNumbers(jobs), [jobs]);
    const activeMachines = useMemo(() => machines.filter((machine) => machine.active), [machines]);
    const visibleJobs = useMemo(() => filterJobs(jobs, filters), [jobs, filters]);

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
        const id = `new-op-${opCounter.current}`;
        setDraft((previous) => ({
            ...previous,
            operations: [
                ...previous.operations,
                {
                    id,
                    name: "",
                    routes: activeMachines[0]
                        ? [{ machineId: activeMachines[0].id, durationMins: 30, energy: null }]
                        : [],
                },
            ],
        }));
        // Keep the baseline aligned so only true reorderings flag as moved.
        setSavedOrder((previous) => [...previous, id]);
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
                    routes: [...routes, { machineId: machine.id, durationMins: 30, energy: null }],
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

    function dragStateFor(index: number): RowDragState {
        const total = draft.operations.length;
        return {
            isDragging: dragIndex === index,
            // The dragged row would land here if released now.
            dropBefore: dragIndex !== null && dropIndex === index && dropIndex !== dragIndex,
            dropAfter:
                dragIndex !== null && dropIndex === total && dropIndex !== dragIndex && index === total - 1,
            landing: recentlyMoved === index,
            armed: dragArmed === index,
        };
    }

    function handleDragStart(index: number, event: React.DragEvent) {
        setDragIndex(index);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(index));
    }

    function handleDragOver(index: number, event: React.DragEvent) {
        if (dragIndex === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        // Which half of the row the pointer is over decides whether the drop
        // lands above or below it.
        const bounds = event.currentTarget.getBoundingClientRect();
        const after = event.clientY > bounds.top + bounds.height / 2;
        setDropIndex(Math.min(index + (after ? 1 : 0), draft.operations.length));
    }

    function handleDrop(event: React.DragEvent) {
        event.preventDefault();
        if (dragIndex !== null && dropIndex !== null) {
            reorderOperation(dragIndex, dragIndex < dropIndex ? dropIndex - 1 : dropIndex);
        }
        resetDrag();
    }

    async function saveDraft() {
        const wasExisting = Boolean(draft.id);
        try {
            const saved = draft.id
                ? await updateJob.mutateAsync({ id: draft.id, job: draft })
                : await createJob.mutateAsync(draft);
            setDraft(draftFromJob(saved));
            if (wasExisting) {
                toast.success(`“${saved.name}” saved.`);
            } else {
                setIsCreating(false);
                toast.success(`“${saved.name}” created in the backlog.`);
            }
            setSavedOrder(saved.operations.map((op) => op.id));
        } catch (error) {
            reportMutationError(error);
        }
    }

    async function removeJob() {
        if (!draft.id) return;
        const removedName = draft.name;
        try {
            await deleteJob.mutateAsync(draft.id);
            setIsCreating(false);
            setDraft(EMPTY_JOB_DRAFT);
            setConfirmingDelete(false);
            setDeleteClosing(false);
            toast.success(`“${removedName}” deleted.`);
        } catch (error) {
            reportMutationError(error);
            setConfirmingDelete(false);
            setDeleteClosing(false);
        }
    }

    // Read states only. A healthy screen says nothing — the editor's own
    // controls already explain that saving writes to the API.
    const notes = (
        <>
            {loading && (
                <Note intent="info" role="status">
                    Loading the job backlog and machines…
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
        </>
    );

    return (
        <ManagerShell
            actions={
                <Button onPress={startNewJob} isDisabled={loading || saving}>
                    <PlusIcon /> New job
                </Button>
            }
        >
            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(280px,0.8fr)_2fr]">
                <JobBacklogPanel
                    jobs={jobs}
                    visibleJobs={visibleJobs}
                    machines={machines}
                    colors={colors}
                    sequenceNumbers={sequenceNumbers}
                    selectedJobId={draft.id}
                    filters={filters}
                    onFiltersChange={(update) => setFilters(update)}
                    onSelect={editJob}
                />

                <JobEditorPanel
                    draft={draft}
                    sequenceNumber={draft.id ? sequenceNumbers.get(draft.id) : undefined}
                    machines={machines}
                    activeMachines={activeMachines}
                    savedOrder={savedOrder}
                    loading={loading}
                    saving={saving}
                    hasLoadError={Boolean(loadError)}
                    notes={notes}
                    dragStateFor={dragStateFor}
                    onNameChange={(name) => setDraft((previous) => ({ ...previous, name }))}
                    onPriorityChange={(priority) => setDraft((previous) => ({ ...previous, priority }))}
                    onAddOperation={addOperation}
                    onArmDrag={setDragArmed}
                    onResetDrag={resetDrag}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    onMoveOperation={moveOperation}
                    onRemoveOperation={removeOperation}
                    onPatchOperation={patchOperation}
                    onPatchRoute={patchRoute}
                    onAddRoute={addRoute}
                    onRemoveRoute={removeRoute}
                    onSave={saveDraft}
                    onRequestDelete={() => setConfirmingDelete(true)}
                />
            </main>

            {confirmingDelete && draft.id && (
                <DeleteJobDialog
                    jobName={draft.name}
                    sequenceNumber={sequenceNumbers.get(draft.id)}
                    closing={deleteClosing}
                    onConfirm={removeJob}
                    onDismiss={dismissDelete}
                />
            )}
        </ManagerShell>
    );
}
