import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import { formatDuration, primaryRoute, totalWorkMins } from "@/domains/scheduling/format";
import type { Machine, OperationDef } from "@/domains/scheduling/types";
import { CheckIcon, CursorArrowRaysIcon, PlusIcon } from "@heroicons/react/24/outline";
import { wouldCreateCycle } from "../model/dependencies";
import { JOB_PRIORITIES, type JobDraft } from "../model/editor";
import { JobGraphDiagram } from "./JobGraphDiagram";
import { OperationDetailPanel } from "./OperationDetailPanel";

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
    onSelectOperation: (operationId: string | null) => void;
    onSave: () => void;
    onRequestDelete: () => void;
}) {
    const workMins = totalWorkMins(draft);
    const machineCount = new Set(
        draft.operations.flatMap((operation) => operation.routes.map((route) => route.machineId)),
    ).size;
    const nodes = draft.operations.map((operation) => ({ id: operation.id, dependsOn: operation.dependsOn }));
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
