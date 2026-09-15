import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import type { Machine, OperationDef } from "@/domains/scheduling/types";
import { ArrowDownIcon, ArrowUpIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { DraftOperation } from "../model/editor";
import { OperationRoutes } from "./OperationRoutes";
import { PredecessorPicker, type PredecessorOption } from "./PredecessorPicker";

/**
 * The step the graph currently has open, edited beside it.
 *
 * A panel rather than a dialog on purpose: the point of editing from the graph
 * is watching the graph answer. A modal would cover the very thing the edit is
 * about — rename a step or change what it waits on and the shape beside you
 * redraws as you type, which a dialog would hide behind itself.
 *
 * It holds no state. Every control writes to the same draft the operation cards
 * below write to, so the two surfaces cannot disagree.
 */
export function OperationDetailPanel({
    operation,
    index,
    total,
    machines,
    activeMachines,
    saving,
    predecessorOptions,
    onPatch,
    onDependenciesChange,
    onPatchRoute,
    onAddRoute,
    onRemoveRoute,
    onMove,
    onRemove,
}: {
    operation: DraftOperation | null;
    index: number;
    total: number;
    machines: Machine[];
    activeMachines: Machine[];
    saving: boolean;
    predecessorOptions: PredecessorOption[];
    onPatch: (patch: Partial<Pick<OperationDef, "name">>) => void;
    onDependenciesChange: (predecessorIds: string[]) => void;
    onPatchRoute: (routeIndex: number, patch: Partial<OperationDef["routes"][number]>) => void;
    onAddRoute: () => void;
    onRemoveRoute: (routeIndex: number) => void;
    onMove: (offset: number) => void;
    onRemove: () => void;
}) {
    if (operation === null) {
        return (
            <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed p-5 text-center text-muted-fg text-sm">
                Select a step in the graph to edit it here.
            </div>
        );
    }

    const label = operation.name.trim() || `untitled step ${index + 1}`;

    return (
        <div className="flex flex-col gap-3 rounded-xl border bg-overlay p-3">
            <div className="flex items-center justify-between gap-2">
                <span className="truncate font-semibold text-sm">
                    {operation.name.trim() || <span className="text-muted-fg italic">Untitled step</span>}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                    <Button
                        intent="plain"
                        size="sq-xs"
                        onPress={() => onMove(-1)}
                        isDisabled={index <= 0}
                        aria-label={`Move ${label} earlier`}
                    >
                        <ArrowUpIcon />
                    </Button>
                    <Button
                        intent="plain"
                        size="sq-xs"
                        onPress={() => onMove(1)}
                        isDisabled={index >= total - 1}
                        aria-label={`Move ${label} later`}
                    >
                        <ArrowDownIcon />
                    </Button>
                    <Button intent="plain" size="sq-xs" onPress={onRemove} aria-label={`Remove ${label}`}>
                        <TrashIcon />
                    </Button>
                </span>
            </div>

            <TextField value={operation.name} onChange={(name) => onPatch({ name })} autoFocus>
                <Label className="text-muted-fg text-xs">Step name</Label>
                <Input placeholder="Operation name" autoComplete="off" />
            </TextField>

            <PredecessorPicker
                label={label}
                options={predecessorOptions}
                selected={operation.dependsOn}
                onChange={onDependenciesChange}
            />

            <OperationRoutes
                routes={operation.routes}
                machines={machines}
                activeMachines={activeMachines}
                saving={saving}
                label={label}
                stacked
                onPatchRoute={onPatchRoute}
                onAddRoute={onAddRoute}
                onRemoveRoute={onRemoveRoute}
            />
        </div>
    );
}
