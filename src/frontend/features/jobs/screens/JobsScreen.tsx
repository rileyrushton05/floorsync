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
    useJobDependencies,
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
import { edgesForSavedOperations } from "@/features/jobs/model/dependencies";
import {
    DEFAULT_SORT,
    EMPTY_JOB_DRAFT,
    applyDependencies,
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
    // Which step the graph has open. Held here rather than in the graph because
    // the operation cards highlight the same selection and edit the same draft.
    const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);

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

    // A job opens showing the straight chain its operation order implies, then
    // its real graph arrives from its own endpoint and replaces that. Guarded by
    // `graphLoadedFor` so a later refetch never discards an edit in progress —
    // the same render-time settle the job selection above uses.
    const dependencyQuery = useJobDependencies(draft.id);
    const [graphLoadedFor, setGraphLoadedFor] = useState<string | null>(null);
    const loadedEdges = dependencyQuery.data?.edges;
    if (draft.id !== null && loadedEdges !== undefined && graphLoadedFor !== draft.id) {
        const openJobId = draft.id;
        setGraphLoadedFor(openJobId);
        setDraft((previous) => (previous.id === openJobId ? applyDependencies(previous, loadedEdges) : previous));
    }

    const colors = useMemo(() => buildJobColors(jobs), [jobs]);
    const sequenceNumbers = useMemo(() => jobSequenceNumbers(jobs), [jobs]);
    const activeMachines = useMemo(() => machines.filter((machine) => machine.active), [machines]);
    const visibleJobs = useMemo(() => filterJobs(jobs, filters), [jobs, filters]);

    function startNewJob() {
        setIsCreating(true);
        setDraft(EMPTY_JOB_DRAFT);
        setSavedOrder([]);
        setSelectedOperationId(null);
    }

    function editJob(job: JobDef) {
        setIsCreating(false);
        setDraft(draftFromJob(job));
        setSavedOrder(job.operations.map((op) => op.id));
        setSelectedOperationId(null);
    }

    function addOperation() {
        opCounter.current += 1;
        const id = `new-op-${opCounter.current}`;
        setDraft((previous) => {
            // A new step joins the end of the chain by default, which is what
            // adding one used to mean. Anything else is an explicit edit.
            const last = previous.operations.at(-1);
            return {
                ...previous,
                operations: [
                    ...previous.operations,
                    {
                        id,
                        name: "",
                        dependsOn: last ? [last.id] : [],
                        routes: activeMachines[0]
                            ? [{ machineId: activeMachines[0].id, durationMins: 30, energy: null }]
                            : [],
                    },
                ],
            };
        });
        // Keep the baseline aligned so only true reorderings flag as moved.
        setSavedOrder((previous) => [...previous, id]);
        // Open it immediately: a step added from the graph is added in order to
        // be filled in, and it lands unnamed with a default route.
        setSelectedOperationId(id);
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
        if (draft.operations[index]?.id === selectedOperationId) setSelectedOperationId(null);
        setDraft((previous) => {
            const removed = previous.operations[index];
            if (removed === undefined) return previous;
            return {
                ...previous,
                operations: previous.operations
                    .filter((_, i) => i !== index)
                    .map((operation) => {
                        if (!operation.dependsOn.includes(removed.id)) return operation;
                        // Whatever waited on the removed step now waits on what
                        // *it* waited on. Dropping the edge outright would let a
                        // later step start first, which is never what deleting a
                        // step in the middle is meant to say.
                        const inherited = operation.dependsOn
                            .filter((id) => id !== removed.id)
                            .concat(removed.dependsOn);
                        return { ...operation, dependsOn: [...new Set(inherited)] };
                    }),
            };
        });
        // Close the same gap in the baseline so surviving rows keep their
        // original relative positions (and don't falsely flag as reordered).
        setSavedOrder((previous) => {
            const removed = draft.operations[index]?.id;
            return removed ? previous.filter((id) => id !== removed) : previous;
        });
    }

    /** Set what one operation waits on. The graph, not list order, decides this. */
    function setDependencies(operationIndex: number, predecessorIds: string[]) {
        setDraft((previous) => ({
            ...previous,
            // Hold predecessors in the job's own operation order so the chips
            // read the same way however they were clicked.
            operations: previous.operations.map((operation, index) =>
                index === operationIndex
                    ? {
                        ...operation,
                        dependsOn: previous.operations
                            .map((candidate) => candidate.id)
                            .filter((id) => predecessorIds.includes(id)),
                    }
                    : operation,
            ),
        }));
    }

    /** List order is display order; it no longer decides precedence on its own. */
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
            // `draftFromJob` reopens on the chain default, so re-apply the graph
            // that was just written — translated onto the ids the API assigned.
            // Without this the editor would show a chain until the refetch
            // landed, which reads as the save having discarded the graph.
            setDraft(
                applyDependencies(
                    draftFromJob(saved),
                    edgesForSavedOperations(draft.operations, saved.operations.map((op) => op.id)),
                ),
            );
            setGraphLoadedFor(saved.id);
            // A step created in this draft had a placeholder id the server has
            // now replaced, so keep the panel on the same step by position.
            setSelectedOperationId((previous) => {
                const openAt = draft.operations.findIndex((op) => op.id === previous);
                return openAt >= 0 ? saved.operations[openAt]?.id ?? null : null;
            });
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
                    onDependenciesChange={setDependencies}
                    selectedOperationId={selectedOperationId}
                    onSelectOperation={setSelectedOperationId}
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
