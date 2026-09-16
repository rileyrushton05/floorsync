import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import type { Machine, OperationDef } from "@/domains/scheduling/types";
import { TrashIcon } from "@heroicons/react/24/outline";
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
 * It holds no state — every control writes straight to the job draft, which is
 * what the graph renders from, so the picture and the fields cannot disagree.
 *
 * There is no move control. Order no longer decides what waits for what, and
 * once the step list was replaced by the graph the only thing it still affected
 * was left-to-right placement among steps sharing a row — so the buttons did
 * nothing visible whenever the neighbouring step sat at a different depth.
 * Steps keep a stored position; new ones simply go on the end.
 */
export function OperationDetailPanel({
    operation,
    index,
    machines,
    activeMachines,
    saving,
    predecessorOptions,
    onPatch,
    onDependenciesChange,
    onPatchRoute,
    onAddRoute,
    onRemoveRoute,
    onRemove,
}: {
    operation: DraftOperation | null;
    /** Only used to name an unnamed step for screen readers. */
    index: number;
    machines: Machine[];
    activeMachines: Machine[];
    saving: boolean;
    predecessorOptions: PredecessorOption[];
    onPatch: (patch: Partial<Pick<OperationDef, "name">>) => void;
    onDependenciesChange: (predecessorIds: string[]) => void;
    onPatchRoute: (routeIndex: number, patch: Partial<OperationDef["routes"][number]>) => void;
    onAddRoute: () => void;
    onRemoveRoute: (routeIndex: number) => void;
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
                <Button intent="plain" size="sq-xs" onPress={onRemove} aria-label={`Remove ${label}`}>
                    <TrashIcon />
                </Button>
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
