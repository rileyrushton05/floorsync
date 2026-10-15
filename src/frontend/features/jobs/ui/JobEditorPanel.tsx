"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Link } from "@/components/ui/link";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import { InfoTooltip } from "@/components/ui/tooltip";
import { Note } from "@/components/ui/note";
import { errorMessage } from "@/core/http/errors";
import { useSaveShortcutLabel } from "@/core/keyboard/useSaveShortcut";
import { formatDuration, primaryRoute, routeMins, totalWorkMins } from "@/domains/scheduling/format";
import type { Machine, OperationDef } from "@/domains/scheduling/types";
import {
    ArchiveBoxArrowDownIcon,
    ArrowPathIcon,
    ArrowUturnLeftIcon,
    CheckIcon,
    CursorArrowRaysIcon,
    DocumentDuplicateIcon,
    ExclamationTriangleIcon,
    PlusIcon,
} from "@heroicons/react/24/outline";
import { criticalPathMins, wouldCreateCycle } from "../model/dependencies";
import { JOB_PRIORITIES, UNASSIGNED_MACHINE, type JobDraft, type SaveGate } from "../model/editor";
import { JobGraphDiagram } from "./JobGraphDiagram";
import { OperationDetailPanel } from "./OperationDetailPanel";

/** One figure in the draft summary. */
function Stat({ value, label, hint }: { value: string; label: string; hint?: string }) {
    return (
        <div className="rounded-lg border bg-muted px-3 py-2">
            <div className="font-bold text-lg tabular-nums">{value}</div>
            <div className="text-muted-fg text-xs">{label}</div>
            {hint && <div className="mt-0.5 hidden text-muted-fg text-xs opacity-80 xl:block">{hint}</div>}
        </div>
    );
}

/**
 * The job builder: name, priority, the ordered operation chain and the save /
 * delete actions.
 *
 * Presentational. Every edit leaves through a callback and the authoritative
 * answer to whether a draft is valid comes back from the API, so nothing here
 * blocks a save.
 *
 * A job is editable only while it is open. Planned, done and archived jobs are
 * shown as records with Duplicate as the way to create new work from one.
 */
export function JobEditorPanel({
    draft,
    sequenceNumber,
    machines,
    activeMachines,
    loading,
    saving,
    hasLoadError,
    dirty,
    gate,
    graphError,
    onRetryGraph,
    onDiscard,
    onCancelNew,
    notes,
    onNameChange,
    onPriorityChange,
    onAddOperation,
    onRemoveOperation,
    onPatchOperation,
    onPatchRoute,
    onAddRoute,
    onRemoveRoute,
    onDependenciesChange,
    selectedOperationId,
    focusOperationId,
    onSelectOperation,
    onSave,
    canDuplicate,
    onDuplicate,
    onRequestDelete,
    onRequestArchive,
}: {
    draft: JobDraft;
    sequenceNumber: number | undefined;
    machines: Machine[];
    activeMachines: Machine[];
    loading: boolean;
    saving: boolean;
    hasLoadError: boolean;
    /** Whether the draft differs from the job as the API has it. */
    dirty: boolean;
    /** Whether a save is allowed, and why not — shared with the Ctrl+S shortcut. */
    gate: SaveGate;
    /** Why the precedence graph has not arrived, when the fetch failed outright. */
    graphError: unknown;
    onRetryGraph: () => void;
    onDiscard: () => void;
    /** Leave an unsaved new job for the one it was started from; omitted when there is none. */
    onCancelNew?: () => void;
    notes: React.ReactNode;
    onNameChange: (name: string) => void;
    onPriorityChange: (priority: JobDraft["priority"]) => void;
    onAddOperation: () => void;
    onRemoveOperation: (index: number) => void;
    onPatchOperation: (index: number, patch: Partial<Pick<OperationDef, "name">>) => void;
    onPatchRoute: (
        operationIndex: number,
        routeIndex: number,
        patch: Partial<OperationDef["routes"][number]>,
    ) => void;
    onAddRoute: (operationIndex: number) => void;
    onRemoveRoute: (operationIndex: number, routeIndex: number) => void;
    onDependenciesChange: (operationIndex: number, predecessorIds: string[]) => void;
    selectedOperationId: string | null;
    /** The step that should take the cursor — a step just added, and nothing else. */
    focusOperationId: string | null;
    onSelectOperation: (operationId: string | null) => void;
    onSave: () => void;
    /**
     * Whether a copy would be faithful to the job as stored.
     *
     * False until the job's real precedence graph has arrived: `draftFromJob`
     * opens on a straight chain, so copying before then would quietly turn a
     * branching job into a linear one.
     */
    canDuplicate: boolean;
    /** Open an unsaved copy of this job. The only write action for a read-only job. */
    onDuplicate: () => void;
    onRequestDelete: () => void;
    /** Retire this job from the backlog by hand. One way: there is no un-archive. */
    onRequestArchive: () => void;
}) {
    const shortcut = useSaveShortcutLabel();
    const readOnly = draft.backlogStatus !== "open";
    const scheduleId = draft.plannedByScheduleIds[0] ?? null;
    const workMins = totalWorkMins(draft);
    const durationOf = new Map(
        draft.operations.map((operation) => [operation.id, routeMins(primaryRoute(operation))]),
    );
    const machineCount = new Set(
        draft.operations.flatMap((operation) =>
            operation.routes
                .map((route) => route.machineId)
                .filter((machineId) => machineId !== UNASSIGNED_MACHINE),
        ),
    ).size;
    const nodes = draft.operations.map((operation) => ({ id: operation.id, dependsOn: operation.dependsOn }));
    const elapsedMins = criticalPathMins(nodes, (id) => durationOf.get(id) ?? 0);
    // A save waits on the real graph, on the draft being complete, and on the
    // page being in a state where a write makes sense at all.
    const selectedIndex = draft.operations.findIndex((operation) => operation.id === selectedOperationId);
    const selected = selectedIndex >= 0 ? draft.operations[selectedIndex] : null;
    const predecessorOptionsFor = (operationId: string) =>
        draft.operations
            .filter((candidate) => candidate.id !== operationId)
            .map((candidate) => ({
                id: candidate.id,
                name: candidate.name,
                disabled: wouldCreateCycle(nodes, operationId, candidate.id),
            }));
    const graphOperations = draft.operations.map((operation) => ({
        id: operation.id,
        dependsOn: operation.dependsOn,
        name: operation.name,
        durationMins: primaryRoute(operation)?.durationMins ?? null,
        machineCount: operation.routes.length,
    }));

    return (
        // The card already stretches to the bottom of the screen (its grid row
        // does); the flex chain down to the graph hands it all of that spare
        // height, so the save row sits at the bottom instead of halfway up.
        <Card>
            <CardHeader className="flex-row items-center gap-3">
                <span className="flex items-center gap-2.5">
                    <CardTitle>{readOnly ? "Job record" : draft.id ? "Edit job" : "New job"}</CardTitle>
                    {draft.id && sequenceNumber !== undefined && (
                        <Badge intent="secondary">#{sequenceNumber}</Badge>
                    )}
                    {readOnly && (
                        <Badge intent="secondary" role="status">
                            {draft.backlogStatus === "done"
                                ? "Done"
                                : draft.backlogStatus[0]?.toUpperCase() + draft.backlogStatus.slice(1)}
                        </Badge>
                    )}
                    {/* Every control below is inert once the job has left the backlog;
                        the tooltip says why and points at the one action that works. */}
                    {readOnly && (
                        <InfoTooltip label="Why this job is read-only">
                            This job is {draft.backlogStatus}, so it is no longer editable or offered
                            for scheduling. Duplicate it to start a new job from the same steps,
                            machines and ordering.
                            {draft.backlogStatus === "archived" && draft.archivedAt !== null && (
                                <> Archived since {new Date(draft.archivedAt).toLocaleString()}.</>
                            )}
                        </InfoTooltip>
                    )}
                    {readOnly && scheduleId !== null && (
                        <Link
                            href={`/manager/schedules?schedule=${encodeURIComponent(scheduleId)}`}
                            className="text-sm underline"
                        >
                            Open its schedule
                        </Link>
                    )}
                    {/* Unsaved work is otherwise invisible until something tries
                        to navigate away and a dialog appears out of nowhere. */}
                    {dirty && (
                        <Badge intent="warning" role="status">
                            Unsaved changes
                        </Badge>
                    )}
                </span>
            </CardHeader>

            <CardContent className="flex flex-1 flex-col gap-3 sm:gap-4">
                {notes}

                {/* Without this the editor would quietly present the straight
                    chain `draftFromJob` opens on as though it were the job. */}
                {graphError !== null && graphError !== undefined && (
                    <Note intent="danger" role="alert">
                        <strong>Could not load the order this job&rsquo;s steps run in.</strong>
                        <div className="mt-1">{errorMessage(graphError)}</div>
                        <div className="mt-1">
                            The steps below are shown running one after another, which may not be
                            how this job is stored. Saving is held until the real order loads.
                        </div>
                        <Button intent="outline" size="sm" className="mt-2.5" onPress={onRetryGraph}>
                            <ArrowPathIcon /> Try again
                        </Button>
                    </Note>
                )}

                <div className="flex flex-col gap-4 sm:flex-row">
                    <TextField
                        className="flex-2"
                        value={draft.name}
                        isReadOnly={readOnly}
                        onChange={onNameChange}
                    >
                        <Label>Job name</Label>
                        <Input placeholder="e.g. Produce Glass" autoComplete="off" />
                    </TextField>

                    <Select
                        className="flex-1"
                        value={draft.priority}
                        isDisabled={readOnly}
                        onChange={(priority) => onPriorityChange(priority as JobDraft["priority"])}
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

                {/* Only a graph claims the card's spare height. With no steps
                    yet there is nothing to grow into it, so the footer sits
                    straight under the empty message instead of at the bottom. */}
                <div className={`flex flex-col ${draft.operations.length > 0 ? "flex-1" : ""}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-semibold text-sm">Operations</h3>
                        {!readOnly && (
                            <Button
                                intent="primary"
                                size="sm"
                                onPress={onAddOperation}
                                isDisabled={saving || loading || hasLoadError}
                            >
                                <PlusIcon /> Add operation
                            </Button>
                        )}
                    </div>
                    <p className="mt-1 flex items-center gap-1 text-muted-fg text-xs">
                        <CursorArrowRaysIcon className="size-3.5" />
                        {readOnly
                            ? "Click a step to see the machines it ran on and what it waited for"
                            : "Click a step to edit it: “Runs after” decides what waits for what"}
                    </p>

                    {draft.operations.length === 0 ? (
                        <div className="mt-3 rounded-xl border border-dashed p-6 text-center text-muted-fg text-sm">
                            {readOnly
                                ? "This job has no operations recorded."
                                : "No operations yet. A job needs at least one."}
                        </div>
                    ) : (
                        <div className="mt-2 flex flex-1 flex-col gap-2.5">
                            <JobGraphDiagram
                                operations={graphOperations}
                                selectedId={selectedOperationId}
                                onSelect={onSelectOperation}
                            />
                            <OperationDetailPanel
                                operation={selected}
                                index={selectedIndex}
                                autoFocusName={selected !== null && selected.id === focusOperationId}
                                foreignPredecessors={
                                    selected === null
                                        ? 0
                                        : draft.foreignEdges.filter(
                                            (edge) => edge.after_operation_id === selected.id,
                                        ).length
                                }
                                machines={machines}
                                activeMachines={activeMachines}
                                saving={saving}
                                readOnly={readOnly}
                                predecessorOptions={selected ? predecessorOptionsFor(selected.id) : []}
                                onPatch={(patch) => onPatchOperation(selectedIndex, patch)}
                                onDependenciesChange={(ids) => onDependenciesChange(selectedIndex, ids)}
                                onPatchRoute={(routeIndex, patch) => onPatchRoute(selectedIndex, routeIndex, patch)}
                                onAddRoute={() => onAddRoute(selectedIndex)}
                                onRemoveRoute={(routeIndex) => onRemoveRoute(selectedIndex, routeIndex)}
                                onRemove={() => onRemoveOperation(selectedIndex)}
                            />
                        </div>
                    )}

                </div>

                <Separator />

                {/* "Duration" used to be the sum of every step, which was
                    defensible while a job could only be a chain. It is not any
                    more: steps sharing a row in the graph run at once, so the
                    sum overstates how long the job takes. Both figures are shown
                    and each is named for what it actually measures. */}
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    <Stat
                        value={String(draft.operations.length)}
                        label={draft.operations.length === 1 ? "Operation" : "Operations"}
                    />
                    <Stat
                        value={formatDuration(workMins)}
                        label="Total work"
                        hint="Every step added up"
                    />
                    <Stat
                        value={formatDuration(elapsedMins)}
                        label="Longest path"
                        hint="If parallel steps run at once"
                    />
                    <Stat
                        value={String(machineCount)}
                        label={machineCount === 1 ? "Machine" : "Machines"}
                        hint="Compatible across all steps"
                    />
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2.5">
                    {/* A disabled button with no reason beside it is a dead end.
                        The message says what to do, in the same place every
                        time, rather than arriving as a toast after a round trip
                        the draft was never going to survive. */}
                    {gate.reason !== null && (
                        <span
                            className={
                                gate.needsFix
                                    ? "me-auto flex items-center gap-1.5 rounded-md bg-warning-subtle px-2.5 py-1.5 font-medium text-sm text-warning-subtle-fg"
                                    : "me-auto text-muted-fg text-sm"
                            }
                            role="status"
                        >
                            {gate.needsFix && <ExclamationTriangleIcon className="size-4 shrink-0" />}
                            {gate.reason}
                        </span>
                    )}
                    {/* Copying is offered for any saved job; it is the only write action
                        once a job has left the backlog. */}
                    {draft.id && (
                        <Button
                            intent={readOnly ? "primary" : "outline"}
                            onPress={onDuplicate}
                            isDisabled={!canDuplicate || saving || loading || hasLoadError}
                        >
                            <DocumentDuplicateIcon /> Duplicate
                        </Button>
                    )}
                    {/* Archiving is how a manager takes a job out of the backlog
                        by hand: an open job that will never be run, or a planned
                        one they are cancelling. Not offered on a job that has
                        already left — a done job is out of the backlog anyway,
                        and archiving an archived one does nothing. */}
                    {draft.id && (draft.backlogStatus === "open" || draft.backlogStatus === "planned") && (
                        <Button
                            intent="outline"
                            onPress={onRequestArchive}
                            isDisabled={saving || loading || hasLoadError}
                        >
                            <ArchiveBoxArrowDownIcon /> Archive
                        </Button>
                    )}
                    {/* Deleting a job that has left the backlog is not merely disabled but gone.
                        The API refuses it outright once a confirmed schedule has
                        planned the work, and archiving is what a finished job
                        gets *instead* of deletion — so offering the button would
                        only ever lead to a refusal. */}
                    {draft.id && !readOnly && (
                        <Button
                            intent="danger"
                            onPress={onRequestDelete}
                            isDisabled={saving || loading || hasLoadError}
                        >
                            Delete job
                        </Button>
                    )}
                    {/* Discard is the opposite of Save, so it sits beside it
                        rather than up in the title row. Always rendered, merely
                        disabled while there is nothing to discard: appearing
                        only when the draft is dirty would shift Save sideways
                        under the pointer at the moment of the first keystroke.
                        Both go entirely for a read-only job, which has nothing
                        to save and so nothing to discard either. */}
                    {/* A new job is otherwise only left by clicking some other
                        job in the backlog, which is not where anyone looks for
                        "never mind". Asks first if anything has been entered. */}
                    {!readOnly && !draft.id && onCancelNew && (
                        <Button intent="plain" onPress={onCancelNew} isDisabled={saving}>
                            Cancel
                        </Button>
                    )}
                    {!readOnly && (
                        <Button
                            intent="outline"
                            onPress={onDiscard}
                            isDisabled={!dirty || saving || loading || hasLoadError}
                        >
                            <ArrowUturnLeftIcon /> Discard changes
                        </Button>
                    )}
                    {!readOnly && (
                        <Button
                            onPress={onSave}
                            isPending={saving}
                            isDisabled={!gate.canSave}
                            aria-keyshortcuts="Control+S Meta+S"
                        >
                            <CheckIcon /> {draft.id ? "Save changes" : "Create job"}
                            {/* A shortcut nobody is told about is a shortcut
                                nobody uses. Rendered only after mount, so the
                                server and the first client render agree on
                                nothing rather than on a guess about which
                                platform this is. */}
                            {shortcut !== null && (
                                <kbd
                                    aria-hidden
                                    className="ms-1 font-sans text-[0.75em] opacity-70"
                                >
                                    {shortcut}
                                </kbd>
                            )}
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
