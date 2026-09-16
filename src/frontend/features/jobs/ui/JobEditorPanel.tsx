"use client";

import { useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import { Note } from "@/components/ui/note";
import { errorMessage } from "@/core/http/errors";
import { formatDuration, primaryRoute, routeMins, totalWorkMins } from "@/domains/scheduling/format";
import type { Machine, OperationDef } from "@/domains/scheduling/types";
import {
    ArrowPathIcon,
    ArrowUturnLeftIcon,
    CheckIcon,
    CursorArrowRaysIcon,
    PlusIcon,
} from "@heroicons/react/24/outline";
import { criticalPathMins, wouldCreateCycle } from "../model/dependencies";
import { JOB_PRIORITIES, type JobDraft, type SaveGate } from "../model/editor";
import { JobGraphDiagram } from "./JobGraphDiagram";
import { OperationDetailPanel } from "./OperationDetailPanel";

/**
 * Which save chord to print, or null while there is no platform to ask.
 *
 * The server cannot know, and guessing then correcting on hydration would flash
 * the wrong label. `useSyncExternalStore` is the shape for exactly this: a
 * server snapshot of null, a client snapshot read off the platform, and no
 * subscription because the answer never changes within a session.
 */
const NEVER_CHANGES = () => () => { };
const readShortcut = () =>
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent) ? "⌘S" : "Ctrl+S";
const noShortcutOnServer = () => null;

/** One figure in the draft summary. */
function Stat({ value, label, hint }: { value: string; label: string; hint?: string }) {
    return (
        <div className="rounded-lg border bg-muted p-3">
            <div className="font-bold text-xl tabular-nums">{value}</div>
            <div className="text-muted-fg text-xs">{label}</div>
            {hint && <div className="mt-0.5 text-muted-fg text-xs opacity-80">{hint}</div>}
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
    onRequestDelete,
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
    onRequestDelete: () => void;
}) {
    const shortcut = useSyncExternalStore(NEVER_CHANGES, readShortcut, noShortcutOnServer);
    const workMins = totalWorkMins(draft);
    const durationOf = new Map(
        draft.operations.map((operation) => [operation.id, routeMins(primaryRoute(operation))]),
    );
    const machineCount = new Set(
        draft.operations.flatMap((operation) => operation.routes.map((route) => route.machineId)),
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
        <Card>
            <CardHeader className="flex-row items-center gap-3">
                <span className="flex items-center gap-2.5">
                    <CardTitle>{draft.id ? "Edit job" : "New job"}</CardTitle>
                    {draft.id && sequenceNumber !== undefined && (
                        <Badge intent="secondary">#{sequenceNumber}</Badge>
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

            <CardContent className="space-y-5">
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
                    <TextField className="flex-2" value={draft.name} onChange={onNameChange}>
                        <Label>Job name</Label>
                        <Input placeholder="e.g. Dryer not working" autoComplete="off" />
                    </TextField>

                    <Select
                        className="flex-1"
                        value={draft.priority}
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

                <div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-semibold text-sm">Operations</h3>
                        <Button
                            intent="primary"
                            size="sm"
                            onPress={onAddOperation}
                            isDisabled={saving || loading || hasLoadError || activeMachines.length === 0}
                        >
                            <PlusIcon /> Add operation
                        </Button>
                    </div>
                    <p className="mt-1 flex items-center gap-1 text-muted-fg text-xs">
                        <CursorArrowRaysIcon className="size-3.5" />
                        Click a step to edit it: &ldquo;Runs after&rdquo; decides what waits for what
                    </p>

                    {draft.operations.length === 0 ? (
                        <div className="mt-3 rounded-xl border border-dashed p-6 text-center text-muted-fg text-sm">
                            No operations yet — a job needs at least one.
                        </div>
                    ) : (
                        <div className="mt-3 grid items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,21rem)]">
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
                        <span className="me-auto text-muted-fg text-sm" role="status">
                            {gate.reason}
                        </span>
                    )}
                    {draft.id && (
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
                        under the pointer at the moment of the first keystroke. */}
                    <Button
                        intent="outline"
                        onPress={onDiscard}
                        isDisabled={!dirty || saving || loading || hasLoadError}
                    >
                        <ArrowUturnLeftIcon /> Discard changes
                    </Button>
                    <Button
                        onPress={onSave}
                        isPending={saving}
                        isDisabled={!gate.canSave}
                        aria-keyshortcuts="Control+S Meta+S"
                    >
                        <CheckIcon /> {draft.id ? "Save changes" : "Create job"}
                        {/* A shortcut nobody is told about is a shortcut nobody
                            uses. Rendered only after mount, so the server and
                            the first client render agree on nothing rather than
                            on a guess about which platform this is. */}
                        {shortcut !== null && (
                            <kbd
                                aria-hidden
                                className="ms-1 font-sans text-[0.75em] opacity-70"
                            >
                                {shortcut}
                            </kbd>
                        )}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
