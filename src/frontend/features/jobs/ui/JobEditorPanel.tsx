import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Note } from "@/components/ui/note";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import { formatDuration, primaryRoute, totalWorkMins } from "@/domains/scheduling/format";
import type { Machine, OperationDef } from "@/domains/scheduling/types";
import { Bars2Icon, CheckIcon, PlusIcon } from "@heroicons/react/24/outline";
import { graphShape, wouldCreateCycle } from "../model/dependencies";
import { JOB_PRIORITIES, type JobDraft } from "../model/editor";
import { JobGraphDiagram } from "./JobGraphDiagram";
import { OperationDetailPanel } from "./OperationDetailPanel";
import { OperationEditor, type RowDragState } from "./OperationEditor";

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
    savedOrder,
    loading,
    saving,
    hasLoadError,
    notes,
    dragStateFor,
    onNameChange,
    onPriorityChange,
    onAddOperation,
    onArmDrag,
    onResetDrag,
    onDragStart,
    onDragOver,
    onDrop,
    onMoveOperation,
    onRemoveOperation,
    onPatchOperation,
    onPatchRoute,
    onAddRoute,
    onRemoveRoute,
    onDependenciesChange,
    selectedOperationId,
    onSelectOperation,
    onSave,
    onRequestDelete,
}: {
    draft: JobDraft;
    sequenceNumber: number | undefined;
    machines: Machine[];
    activeMachines: Machine[];
    savedOrder: string[];
    loading: boolean;
    saving: boolean;
    hasLoadError: boolean;
    notes: React.ReactNode;
    dragStateFor: (index: number) => RowDragState;
    onNameChange: (name: string) => void;
    onPriorityChange: (priority: JobDraft["priority"]) => void;
    onAddOperation: () => void;
    onArmDrag: (index: number) => void;
    onResetDrag: () => void;
    onDragStart: (index: number, event: React.DragEvent) => void;
    onDragOver: (index: number, event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
    onMoveOperation: (index: number, offset: number) => void;
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
    onSelectOperation: (operationId: string | null) => void;
    onSave: () => void;
    onRequestDelete: () => void;
}) {
    const workMins = totalWorkMins(draft);
    const machineCount = new Set(
        draft.operations.flatMap((operation) => operation.routes.map((route) => route.machineId)),
    ).size;
    const orderChanged = draft.operations.some((operation, index) => savedOrder[index] !== operation.id);
    const nodes = draft.operations.map((operation) => ({ id: operation.id, dependsOn: operation.dependsOn }));
    const shape = graphShape(nodes);
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
            <CardHeader className="flex-row items-center justify-between gap-3">
                <span className="flex items-center gap-2.5">
                    <CardTitle>{draft.id ? "Edit job" : "New job"}</CardTitle>
                    {draft.id && sequenceNumber !== undefined && (
                        <Badge intent="secondary">#{sequenceNumber}</Badge>
                    )}
                </span>
                {orderChanged && <Badge intent="primary">Unsaved order</Badge>}
            </CardHeader>

            <CardContent className="space-y-5">
                {notes}

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
                        <Bars2Icon className="size-3.5" />
                        Click a step to edit it — order is for reading, &ldquo;Runs after&rdquo; decides what waits
                    </p>

                    {draft.operations.length > 0 && (
                        <div className="mt-3 grid items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,21rem)]">
                            <JobGraphDiagram
                                operations={graphOperations}
                                selectedId={selectedOperationId}
                                onSelect={onSelectOperation}
                            />
                            <OperationDetailPanel
                                operation={selected}
                                index={selectedIndex}
                                total={draft.operations.length}
                                machines={machines}
                                activeMachines={activeMachines}
                                saving={saving}
                                predecessorOptions={selected ? predecessorOptionsFor(selected.id) : []}
                                onPatch={(patch) => onPatchOperation(selectedIndex, patch)}
                                onDependenciesChange={(ids) => onDependenciesChange(selectedIndex, ids)}
                                onPatchRoute={(routeIndex, patch) => onPatchRoute(selectedIndex, routeIndex, patch)}
                                onAddRoute={() => onAddRoute(selectedIndex)}
                                onRemoveRoute={(routeIndex) => onRemoveRoute(selectedIndex, routeIndex)}
                                onMove={(offset) => onMoveOperation(selectedIndex, offset)}
                                onRemove={() => onRemoveOperation(selectedIndex)}
                            />
                        </div>
                    )}

                    {!shape.isLinear && (
                        <Note intent="warning" className="mt-3" role="status">
                            <strong>This blocks schedule generation.</strong>
                            <p className="mt-1">
                                The graph saves fine, but a run plans every job at once and will be
                                refused while this one branches — so no schedule can be generated
                                for the whole floor until it is a straight chain again. The engine
                                accepts at most one predecessor and one successor per operation,
                                and{" "}
                                {shape.fanOut.length > 0 && (
                                    <>
                                        {shape.fanOut.length} {shape.fanOut.length === 1 ? "step has" : "steps have"}{" "}
                                        more than one step waiting on{" "}
                                        {shape.fanOut.length === 1 ? "it" : "them"}
                                    </>
                                )}
                                {shape.fanOut.length > 0 && shape.fanIn.length > 0 && ", and "}
                                {shape.fanIn.length > 0 && (
                                    <>
                                        {shape.fanIn.length} {shape.fanIn.length === 1 ? "step waits" : "steps wait"} on
                                        more than one other step
                                    </>
                                )}
                                .
                            </p>
                        </Note>
                    )}

                    <ol className="mt-3 space-y-2">
                        {draft.operations.map((operation, index) => (
                            <OperationEditor
                                key={operation.id}
                                operation={operation}
                                index={index}
                                total={draft.operations.length}
                                machines={machines}
                                activeMachines={activeMachines}
                                saving={saving}
                                reordered={savedOrder[index] !== operation.id}
                                drag={dragStateFor(index)}
                                selected={operation.id === selectedOperationId}
                                predecessorOptions={predecessorOptionsFor(operation.id)}
                                onDependenciesChange={(ids) => onDependenciesChange(index, ids)}
                                onArmDrag={() => onArmDrag(index)}
                                onResetDrag={onResetDrag}
                                onDragStart={(event) => onDragStart(index, event)}
                                onDragOver={(event) => onDragOver(index, event)}
                                onDrop={onDrop}
                                onMove={(offset) => onMoveOperation(index, offset)}
                                onRemove={() => onRemoveOperation(index)}
                                onPatch={(patch) => onPatchOperation(index, patch)}
                                onPatchRoute={(routeIndex, patch) => onPatchRoute(index, routeIndex, patch)}
                                onAddRoute={() => onAddRoute(index)}
                                onRemoveRoute={(routeIndex) => onRemoveRoute(index, routeIndex)}
                            />
                        ))}
                        {draft.operations.length === 0 && (
                            <li className="rounded-xl border border-dashed p-5 text-center text-muted-fg text-sm">
                                No operations yet — a job needs at least one.
                            </li>
                        )}
                    </ol>
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    <Stat
                        value={String(draft.operations.length)}
                        label={draft.operations.length === 1 ? "Operation" : "Operations"}
                    />
                    <Stat
                        value={formatDuration(workMins)}
                        label="Duration"
                        hint="On each step's first machine"
                    />
                    <Stat
                        value={String(machineCount)}
                        label={machineCount === 1 ? "Machine" : "Machines"}
                        hint="Compatible across all steps"
                    />
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2.5">
                    {draft.id && (
                        <Button
                            intent="danger"
                            onPress={onRequestDelete}
                            isDisabled={saving || loading || hasLoadError}
                        >
                            Delete job
                        </Button>
                    )}
                    <Button onPress={onSave} isPending={saving} isDisabled={loading || hasLoadError}>
                        <CheckIcon /> {draft.id ? "Save changes" : "Create job"}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
