"use client";

import { Button } from "@/components/ui/button";
import { Note } from "@/components/ui/note";
import { errorMessage } from "@/core/http/errors";
import { reportBackendFailure, reportMutationError } from "@/core/feedback/reportMutationError";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { buildJobColors } from "@/domains/scheduling/colors";
import type { JobDef, OperationDef } from "@/domains/scheduling/types";
import {
    JobGraphWriteError,
    useArchiveJob,
    useCreateJobDefinition,
    useDeleteJobDefinition,
    useJobDefinitions,
    useJobDependencies,
    useUpdateJobDefinition,
} from "@/features/jobs/data/queries";
import { scheduleReferences, type ScheduleReferences } from "@/features/jobs/data/api";
import { useDeleteSchedule } from "@/features/schedules/data/queries";
import { useMachines } from "@/features/machines/data/queries";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DeleteJobDialog } from "@/features/jobs/ui/DeleteJobDialog";
import { JobBacklogPanel } from "@/features/jobs/ui/JobBacklogPanel";
import { JobEditorPanel } from "@/features/jobs/ui/JobEditorPanel";
import { edgesForSavedOperations } from "@/features/jobs/model/dependencies";
import { ConfirmDialog } from "@/core/feedback/ConfirmDialog";
import { useNavigationGuard } from "@/core/navigation/NavigationGuard";
import { useSaveShortcut } from "@/core/keyboard/useSaveShortcut";
import {
    DEFAULT_SORT,
    EMPTY_JOB_DRAFT,
    applyDependencies,
    draftFingerprint,
    draftFromJob,
    draftProblem,
    duplicateDraft,
    filterJobs,
    jobSequenceNumbers,
    saveGate,
    type JobDraft,
    type JobFilters,
} from "@/features/jobs/model/editor";

/** How long the zoom-out runs before the dialog unmounts, in ms. */
const CLOSE_MS = 150;

const INITIAL_FILTERS: JobFilters = {
    query: "",
    // The backlog is the work that is left, so the list opens on open jobs.
    // Archived ones are fetched all the same and are one filter change away.
    status: "Active",
    machineId: "All",
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
    const archiveJob = useArchiveJob();
    // Deleting a job the scheduler has only proposed means clearing the
    // proposals first: schedule entries are what the API refuses the delete
    // over, and a draft is the one kind it will let go of.
    const deleteSchedule = useDeleteSchedule();
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
    const saving =
        createJob.isPending ||
        updateJob.isPending ||
        deleteJob.isPending ||
        archiveJob.isPending ||
        deleteSchedule.isPending;
    const searchParams = useSearchParams();
    const [draft, setDraft] = useState<JobDraft>(() => (jobs.length > 0 ? draftFromJob(jobs[0]) : EMPTY_JOB_DRAFT));
    // The job as the API has it. Anything the draft says differently is unsaved
    // work, which is what the leave warnings key off.
    //
    // Held as a draft rather than as its fingerprint so the graph arriving can
    // be applied to *both* — the edges are part of the job as saved, not an
    // edit, and folding them into the baseline alone would also fold in
    // whatever the manager had typed while the fetch was in flight, silently
    // clearing the dirty flag that protects it.
    const [baselineDraft, setBaselineDraft] = useState<JobDraft>(() =>
        jobs.length > 0 ? draftFromJob(jobs[0]) : EMPTY_JOB_DRAFT,
    );
    const [isCreating, setIsCreating] = useState(false);
    /** A job switch or a new job, held back until unsaved work is dealt with. */
    const [pendingOpen, setPendingOpen] = useState<
        { kind: "job"; job: JobDef } | { kind: "cancel"; job: JobDef } | { kind: "new" } | { kind: "duplicate" } | null
    >(null);
    // The job that was open when a new job (or a copy) was started, so
    // cancelling the new one goes back to it rather than to the top of the list.
    const [returnJobId, setReturnJobId] = useState<string | null>(null);
    // Operations are only ever created by a click, so a plain counter is a safe
    // key source — no ids are generated during render.
    const opCounter = useRef(0);
    // Delete confirmation: open state plus a short "closing" window that keeps
    // the dialog mounted while the zoom-out animation plays.
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleteClosing, setDeleteClosing] = useState(false);
    // Another screen can open the backlog narrowed to one machine
    // (?machine=<id>). Every status is shown, since a machine is still bound to
    // the archived jobs that route through it.
    const [filters, setFilters] = useState<JobFilters>(() => {
        const machineId = searchParams.get("machine");
        return machineId ? { ...INITIAL_FILTERS, status: "All", machineId } : INITIAL_FILTERS;
    });
    // Which step the graph has open. Held here rather than in the graph because
    // the operation cards highlight the same selection and edit the same draft.
    const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
    // A step added by a click lands unnamed and wants the cursor; one merely
    // selected in the graph does not, or keyboard traversal of the diagram
    // would throw focus into a text field on every arrow press.
    const [focusOperationId, setFocusOperationId] = useState<string | null>(null);
    /** A step removal held back until it is confirmed — the edit is not undoable. */
    const [pendingOperationRemoval, setPendingOperationRemoval] = useState<number | null>(null);
    /** An archive held back until it is confirmed — there is no un-archive. */
    const [confirmingArchive, setConfirmingArchive] = useState(false);
    /**
     * A delete the API refused, with the draft schedules standing in its way.
     *
     * Only set when every blocker is a draft: that is the one case the page can
     * do something about, by deleting the proposals and asking again. A
     * confirmed schedule in the way is reported as the refusal it is.
     */
    const [blockingDrafts, setBlockingDrafts] = useState<ScheduleReferences | null>(null);

    // The floor definition arrives after authentication. Select its first job
    // only while the editor is pristine, so a delayed API response never
    // overwrites a new draft a manager has already started. This guarded render
    // update settles immediately, without a transient blank draft after load.
    //
    // An open job is preferred over a job that has left the backlog: the list carries both,
    // and landing on a read-only editor would read as the page being broken.
    // Falling back to the first job at all is deliberate — on a floor where
    // everything is archived, showing one is better than showing nothing.
    const firstJobToOpen = jobs.find((job) => job.backlogStatus === "open") ?? jobs[0];
    if (firstJobToOpen && !isCreating && draft.id === null && draft.name === "") {
        openDraft(draftFromJob(firstJobToOpen));
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
    // Starts null, never at `requestedJobId`: the backlog is still loading on
    // the first render, so seeding this with the requested id would mark the
    // link as handled before there was any job to match it against, and the
    // screen would silently fall back to the first job in the backlog.
    const [lastOpenedJobId, setLastOpenedJobId] = useState<string | null>(null);
    if (requestedJobId && requestedJobId !== lastOpenedJobId) {
        const match = jobs.find((job) => job.id === requestedJobId);
        if (match) {
            setLastOpenedJobId(requestedJobId);
            setIsCreating(false);
            openDraft(draftFromJob(match));
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
        setGraphLoadedFor(draft.id);
        // The graph arriving is the job finishing loading, not an edit. It lands
        // on the draft *and* on the baseline independently, so an edit made
        // while the fetch was in flight still reads as unsaved.
        setDraft((previous) => applyDependencies(previous, loadedEdges));
        setBaselineDraft((previous) => applyDependencies(previous, loadedEdges));
    }

    // Until the graph has actually arrived the editor is showing the straight
    // chain `draftFromJob` opens on, which for a branching job is not the job.
    // Saving that would overwrite the real graph with a chain, so a save waits
    // — and a graph that failed to load says so rather than passing a guess off
    // as the job.
    const graphReady = draft.id === null || graphLoadedFor === draft.id;
    const graphError = draft.id !== null && graphLoadedFor !== draft.id ? dependencyQuery.error : null;

    const colors = useMemo(() => buildJobColors(jobs), [jobs]);
    const sequenceNumbers = useMemo(() => jobSequenceNumbers(jobs), [jobs]);
    const activeMachines = useMemo(() => machines.filter((machine) => machine.active), [machines]);
    const visibleJobs = useMemo(() => filterJobs(jobs, filters), [jobs, filters]);

    const readOnly = draft.backlogStatus !== "open";
    const dirty = draftFingerprint(draft) !== draftFingerprint(baselineDraft);
    const gate = saveGate({
        isNew: draft.id === null,
        dirty,
        problem: draftProblem(draft),
        graphReady,
        graphFailed: graphError !== null && graphError !== undefined,
        loading,
        hasLoadError: Boolean(loadError),
        readOnly,
    });
    // A copy is only faithful once the real graph has arrived: `draftFromJob`
    // opens on the straight chain, so duplicating before then would silently
    // flatten a branching job into a linear one.
    const canDuplicate = draft.id !== null && graphReady;
    // Holds in-app links and warns on tab close / reload while work is unsaved.
    useNavigationGuard(dirty, {
        title: "Leave without saving?",
        description: `“${draft.name.trim() || "This job"}” has changes that have not been saved. Leaving this page discards them.`,
        confirmLabel: "Discard and leave",
        cancelLabel: "Stay on this page",
    });

    /** Ctrl+S / ⌘S saves, exactly as pressing the button would. */
    useSaveShortcut(() => {
        // A dialog is a question waiting on an answer; saving the draft behind
        // it would act on something the manager has already stepped away from.
        if (pendingOpen !== null || pendingOperationRemoval !== null || confirmingDelete) return;
        if (saving) return;
        if (gate.canSave) {
            void saveDraft();
            return;
        }
        // Silence is the honest answer to "save" when there is nothing to save.
        // Anything else was an action that did not happen, so it has to say why.
        if (gate.held && gate.reason !== null) toast.warning(gate.reason);
    });

    /** Set the draft *and* the baseline: this is the job as the API has it. */
    function openDraft(next: JobDraft) {
        setDraft(next);
        setBaselineDraft(next);
    }

    /** Put the editor back to the job as saved, throwing the edits away. */
    function discardChanges() {
        setDraft(baselineDraft);
        setSelectedOperationId(null);
        setFocusOperationId(null);
    }

    function openNewJob() {
        setReturnJobId(draft.id ?? returnJobId);
        setIsCreating(true);
        openDraft(EMPTY_JOB_DRAFT);
        setSelectedOperationId(null);
        setFocusOperationId(null);
    }

    function openJob(job: JobDef) {
        setIsCreating(false);
        openDraft(draftFromJob(job));
        setSelectedOperationId(null);
        setFocusOperationId(null);
    }

    /**
     * Open an unsaved copy of the job currently in the editor.
     *
     * Deliberately not `openDraft`: that makes the draft its own baseline, and a
     * copy that reads as already-saved would leave "Create job" disabled on a
     * draft that has everything it needs, and let a navigation away discard it
     * without a word. Against an empty baseline the copy is what it actually is
     * — a complete new job nobody has written yet.
     */
    function openDuplicate() {
        setReturnJobId(draft.id ?? returnJobId);
        setIsCreating(true);
        setDraft(duplicateDraft(draft));
        setBaselineDraft(EMPTY_JOB_DRAFT);
        setSelectedOperationId(null);
        setFocusOperationId(null);
    }

    // Switching jobs replaces the draft outright, so it is the same loss as
    // navigating away and gets the same question first. The backlog's selection
    // follows `draft.id`, so a held-back switch leaves the list where it was.
    function startNewJob() {
        if (dirty) setPendingOpen({ kind: "new" });
        else openNewJob();
    }

    function editJob(job: JobDef) {
        if (job.id === draft.id) return;
        if (dirty) setPendingOpen({ kind: "job", job });
        else openJob(job);
    }

    // Where cancelling a new job lands: the job it was started from if that
    // still exists, otherwise the one the screen opens on. Null when the floor
    // has no jobs at all, in which case there is nothing to cancel back to.
    const cancelTarget = jobs.find((job) => job.id === returnJobId) ?? firstJobToOpen ?? null;

    function cancelNewJob() {
        if (cancelTarget === null) return;
        if (dirty) setPendingOpen({ kind: "cancel", job: cancelTarget });
        else openJob(cancelTarget);
    }

    // Copying replaces the draft, so it is the same loss as switching jobs and
    // asks the same question first.
    function duplicateJob() {
        if (!canDuplicate) return;
        if (dirty) setPendingOpen({ kind: "duplicate" });
        else openDuplicate();
    }

    function addOperation() {
        opCounter.current += 1;
        const id = `new-op-${opCounter.current}`;
        setDraft((previous) => {
            // A new step runs after the step open in the graph, so branching
            // off it is one click. With nothing open it joins the end of the
            // chain, which is what adding one used to mean.
            const after =
                previous.operations.find((op) => op.id === selectedOperationId) ??
                previous.operations.at(-1);
            return {
                ...previous,
                operations: [
                    ...previous.operations,
                    {
                        id,
                        name: "",
                        dependsOn: after ? [after.id] : [],
                        routes: activeMachines[0]
                            ? [{ machineId: activeMachines[0].id, durationMins: 30, energy: null }]
                            : [],
                    },
                ],
            };
        });
        // Open it immediately: a step added from the graph is added in order to
        // be filled in, and it lands unnamed with a default route. Only a step
        // added this way takes the cursor — selecting an existing one in the
        // graph must leave focus where the manager put it.
        setSelectedOperationId(id);
        setFocusOperationId(id);
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
        setFocusOperationId(null);
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

    /**
     * Reopen the editor on the job the API just stored.
     *
     * `draftFromJob` reopens on the chain default, so the graph that was just
     * written is re-applied — translated onto the ids the API assigned. Without
     * this the editor would show a chain until the refetch landed, which reads
     * as the save having discarded the graph.
     */
    function adoptSavedJob(saved: JobDef) {
        const savedIds = saved.operations.map((op) => op.id);
        const stillPresent = new Set(savedIds);
        openDraft(
            applyDependencies(draftFromJob(saved), [
                ...edgesForSavedOperations(draft.operations, savedIds),
                ...draft.foreignEdges.filter((edge) => stillPresent.has(edge.after_operation_id)),
            ]),
        );
        setGraphLoadedFor(saved.id);
        setIsCreating(false);
        // A step created in this draft had a placeholder id the server has now
        // replaced, so keep the panel on the same step by position.
        setSelectedOperationId((previous) => {
            const openAt = draft.operations.findIndex((op) => op.id === previous);
            return openAt >= 0 ? savedIds[openAt] ?? null : null;
        });
        setFocusOperationId(null);
    }

    async function saveDraft() {
        const wasExisting = Boolean(draft.id);
        try {
            const saved = draft.id
                ? await updateJob.mutateAsync({ id: draft.id, job: draft })
                : await createJob.mutateAsync(draft);
            adoptSavedJob(saved);
            toast.success(
                wasExisting ? `“${saved.name}” saved.` : `“${saved.name}” created in the backlog.`,
            );
        } catch (error) {
            // A definition and its precedence are two writes, so a save can
            // half-succeed. The job exists either way: adopt it, or a second
            // press of "Create job" would make a duplicate rather than a retry.
            if (error instanceof JobGraphWriteError) {
                adoptSavedJob(error.saved);
                setGraphLoadedFor(null);
                reportBackendFailure(
                    wasExisting
                        ? `“${error.saved.name}” was saved, but the order its steps run in was not.`
                        : `“${error.saved.name}” was created, but the order its steps run in was not. Fix the problem below and save again.`,
                    [errorMessage(error.cause)],
                );
                return;
            }
            reportMutationError(error);
        }
    }

    /**
     * Delete the open job, optionally clearing the drafts that block it first.
     *
     * The API refuses the delete while any schedule entry points at the job's
     * work, and says which schedules those are. A draft is a proposal nobody
     * has committed to, so the page can offer to delete it and ask again —
     * which is the whole of `clearDrafts`. A confirmed schedule is a record of
     * what the floor was told to do and is reported as the refusal it is.
     */
    async function removeJob(clearDrafts: readonly string[] = []) {
        if (!draft.id) return;
        const removedName = draft.name;
        try {
            for (const scheduleId of clearDrafts) {
                await deleteSchedule.mutateAsync({ id: scheduleId });
            }
            await deleteJob.mutateAsync(draft.id);
            setIsCreating(false);
            openDraft(EMPTY_JOB_DRAFT);
            closeDeletePrompts();
            toast.success(
                clearDrafts.length === 0
                    ? `“${removedName}” deleted.`
                    : `“${removedName}” deleted, along with ${clearDrafts.length} draft ${clearDrafts.length === 1 ? "schedule" : "schedules"}.`,
            );
        } catch (error) {
            // Asking a second time would only be the same refusal: the drafts
            // this round already deleted are gone, so whatever is in the way now
            // is something the page cannot clear.
            const references = clearDrafts.length === 0 ? scheduleReferences(error) : null;
            if (references !== null && references.confirmedScheduleIds.length === 0) {
                setConfirmingDelete(false);
                setDeleteClosing(false);
                setBlockingDrafts(references);
                return;
            }
            reportMutationError(error);
            closeDeletePrompts();
        }
    }

    function closeDeletePrompts() {
        setConfirmingDelete(false);
        setDeleteClosing(false);
        setBlockingDrafts(null);
    }

    /**
     * Retire the open job from the backlog by hand.
     *
     * One way, so it is confirmed first (decision 0018). The editor is reopened
     * on the job as the API now has it — read-only, and from the *saved*
     * baseline rather than the draft: an archived job cannot be saved, so
     * keeping unsaved edits on screen would only offer work that can no longer
     * go anywhere.
     */
    async function archiveJobInEditor() {
        if (!draft.id) return;
        const archivedName = draft.name;
        try {
            const archived = await archiveJob.mutateAsync(draft.id);
            setConfirmingArchive(false);
            setIsCreating(false);
            openDraft({
                ...baselineDraft,
                archivedAt: archived.archived_at,
                backlogStatus: archived.backlog_status,
                plannedByScheduleIds: archived.planned_by_schedule_ids,
            });
            setSelectedOperationId(null);
            setFocusOperationId(null);
            toast.success(`“${archivedName}” archived.`);
        } catch (error) {
            setConfirmingArchive(false);
            reportMutationError(error);
        }
    }

    // Read states only. A healthy screen says nothing — the editor's own
    // controls already explain that saving writes to the API.
    const notes = (
        <>
            {loading && (
                <Note role="status">
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
            <main className="grid flex-1 grid-cols-1 gap-3 p-3 sm:gap-5 sm:p-5 xl:grid-cols-[minmax(240px,0.8fr)_minmax(0,2fr)]">
                <JobBacklogPanel
                    jobs={jobs}
                    visibleJobs={visibleJobs}
                    colors={colors}
                    sequenceNumbers={sequenceNumbers}
                    selectedJobId={draft.id}
                    filters={filters}
                    busy={saving}
                    onFiltersChange={(update) => setFilters(update)}
                    onSelect={editJob}
                />

                <JobEditorPanel
                    draft={draft}
                    sequenceNumber={draft.id ? sequenceNumbers.get(draft.id) : undefined}
                    machines={machines}
                    activeMachines={activeMachines}
                    loading={loading}
                    saving={saving}
                    hasLoadError={Boolean(loadError)}
                    dirty={dirty}
                    gate={gate}
                    graphError={graphError}
                    onRetryGraph={() => void dependencyQuery.refetch()}
                    onDiscard={discardChanges}
                    onCancelNew={cancelTarget === null ? undefined : cancelNewJob}
                    notes={notes}
                    onNameChange={(name) => setDraft((previous) => ({ ...previous, name }))}
                    onPriorityChange={(priority) => setDraft((previous) => ({ ...previous, priority }))}
                    onAddOperation={addOperation}
                    onRemoveOperation={(index) => setPendingOperationRemoval(index)}
                    onPatchOperation={patchOperation}
                    onPatchRoute={patchRoute}
                    onAddRoute={addRoute}
                    onRemoveRoute={removeRoute}
                    onDependenciesChange={setDependencies}
                    selectedOperationId={selectedOperationId}
                    focusOperationId={focusOperationId}
                    onSelectOperation={(operationId) => {
                        setSelectedOperationId(operationId);
                        setFocusOperationId(null);
                    }}
                    onSave={saveDraft}
                    canDuplicate={canDuplicate}
                    onDuplicate={duplicateJob}
                    onRequestDelete={() => setConfirmingDelete(true)}
                    onRequestArchive={() => setConfirmingArchive(true)}
                />
            </main>

            {pendingOpen !== null && (
                <ConfirmDialog
                    // Duplicating is the one case here that loses nothing: the
                    // edits move into the copy rather than being thrown away. It
                    // still asks, because the original goes back to how it was
                    // saved — but it asks in its own words, since a "discard"
                    // warning over an action that discards nothing teaches
                    // people to click through the ones that do.
                    title={
                        pendingOpen.kind === "duplicate"
                            ? "Duplicate with unsaved changes?"
                            : pendingOpen.kind === "cancel"
                                ? "Cancel this new job?"
                                : "Discard unsaved changes?"
                    }
                    description={
                        pendingOpen.kind === "new"
                            ? `“${draft.name.trim() || "This job"}” has changes that have not been saved. Starting a new job discards them.`
                            : pendingOpen.kind === "cancel"
                                ? `“${draft.name.trim() || "This new job"}” has not been created yet. Cancelling throws it away.`
                                : pendingOpen.kind === "duplicate"
                                    ? `The copy is made from what is on screen, unsaved changes included. “${draft.name.trim() || "This job"}” itself stays as it was last saved.`
                                    : `“${draft.name.trim() || "This job"}” has changes that have not been saved. Opening “${pendingOpen.job.name}” discards them.`
                    }
                    confirmLabel={
                        pendingOpen.kind === "duplicate"
                            ? "Duplicate job"
                            : pendingOpen.kind === "cancel"
                                ? "Discard job"
                                : "Discard changes"
                    }
                    cancelLabel="Keep editing"
                    danger={pendingOpen.kind !== "duplicate"}
                    onCancel={() => setPendingOpen(null)}
                    onConfirm={() => {
                        if (pendingOpen.kind === "new") openNewJob();
                        else if (pendingOpen.kind === "duplicate") openDuplicate();
                        else openJob(pendingOpen.job);
                        setPendingOpen(null);
                    }}
                />
            )}

            {pendingOperationRemoval !== null && (
                <ConfirmDialog
                    title="Remove this step?"
                    description={`“${draft.operations[pendingOperationRemoval]?.name.trim() || `Step ${pendingOperationRemoval + 1}`}” and its machines are removed from this job. Anything waiting on it waits on what it waited on instead. Nothing is written until you save.`}
                    confirmLabel="Remove step"
                    cancelLabel="Keep it"
                    danger
                    onCancel={() => setPendingOperationRemoval(null)}
                    onConfirm={() => {
                        removeOperation(pendingOperationRemoval);
                        setPendingOperationRemoval(null);
                    }}
                />
            )}

            {confirmingDelete && draft.id && (
                <DeleteJobDialog
                    jobName={draft.name}
                    sequenceNumber={sequenceNumbers.get(draft.id)}
                    closing={deleteClosing}
                    onConfirm={() => void removeJob()}
                    onDismiss={dismissDelete}
                />
            )}

            {/* The delete was refused, and everything in the way is a draft.
                Asked as its own question rather than folded into the first
                confirmation: deleting someone's proposed schedules is a
                separate consequence, and until the API refused there was no way
                to know it applied. */}
            {blockingDrafts !== null && (
                <ConfirmDialog
                    title={
                        blockingDrafts.draftScheduleIds.length === 1
                            ? "Delete the draft schedule too?"
                            : `Delete ${blockingDrafts.draftScheduleIds.length} draft schedules too?`
                    }
                    description={`“${draft.name.trim() || "This job"}” appears in ${blockingDrafts.draftScheduleIds.length === 1 ? "a draft schedule" : `${blockingDrafts.draftScheduleIds.length} draft schedules`}, which is why it cannot be removed on its own. Deleting ${blockingDrafts.draftScheduleIds.length === 1 ? "that draft" : "those drafts"} clears the way, and then the job goes. Neither can be undone, and nothing confirmed is touched.`}
                    confirmLabel="Delete drafts and job"
                    cancelLabel="Keep everything"
                    danger
                    onCancel={() => setBlockingDrafts(null)}
                    onConfirm={() => void removeJob(blockingDrafts.draftScheduleIds)}
                />
            )}

            {confirmingArchive && draft.id && (
                <ConfirmDialog
                    title={`Archive “${draft.name.trim() || "this job"}”?`}
                    description={`Archiving takes the job out of the backlog, so it is no longer offered for scheduling and becomes read-only. There is no un-archive duplicating it is the way to a version you can edit.${dirty ? " Unsaved changes here are discarded." : ""}`}
                    confirmLabel="Archive job"
                    cancelLabel="Keep it open"
                    onCancel={() => setConfirmingArchive(false)}
                    onConfirm={() => void archiveJobInEditor()}
                />
            )}
        </ManagerShell>
    );
}
