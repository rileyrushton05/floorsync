import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import type { Machine, OperationDef } from "@/domains/scheduling/types";
import type { DraftOperation } from "../model/editor";
import { ArrowDownIcon, ArrowUpIcon, Bars2Icon, TrashIcon } from "@heroicons/react/24/outline";
import { OperationRoutes } from "./OperationRoutes";
import { PredecessorPicker, type PredecessorOption } from "./PredecessorPicker";

export type { PredecessorOption } from "./PredecessorPicker";

/** Drag state for one row, owned by the screen and handed down. */
export interface RowDragState {
    isDragging: boolean;
    dropBefore: boolean;
    dropAfter: boolean;
    landing: boolean;
    armed: boolean;
}

/**
 * One operation in the list: its name, its place in the order, what it waits
 * on, and the machines that can run it.
 *
 * The same step is also reachable from the graph above, whose side panel edits
 * it through the very same callbacks — both surfaces read one draft, so an edit
 * in either appears in the other and in the graph immediately. `selected` only
 * mirrors what the graph has open: selecting from here as well would mount the
 * side panel mid-click and its autofocus would pull focus out of the field just
 * clicked, so the graph stays the one place a step is chosen.
 */
export function OperationEditor({
    operation,
    index,
    total,
    machines,
    activeMachines,
    saving,
    reordered,
    selected,
    drag,
    predecessorOptions,
    onDependenciesChange,
    onArmDrag,
    onResetDrag,
    onDragStart,
    onDragOver,
    onDrop,
    onMove,
    onRemove,
    onPatch,
    onPatchRoute,
    onAddRoute,
    onRemoveRoute,
}: {
    operation: DraftOperation;
    index: number;
    total: number;
    machines: Machine[];
    activeMachines: Machine[];
    saving: boolean;
    reordered: boolean;
    selected: boolean;
    drag: RowDragState;
    predecessorOptions: PredecessorOption[];
    onDependenciesChange: (predecessorIds: string[]) => void;
    onArmDrag: () => void;
    onResetDrag: () => void;
    onDragStart: (event: React.DragEvent) => void;
    onDragOver: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
    onMove: (offset: number) => void;
    onRemove: () => void;
    onPatch: (patch: Partial<Pick<OperationDef, "name">>) => void;
    onPatchRoute: (routeIndex: number, patch: Partial<OperationDef["routes"][number]>) => void;
    onAddRoute: () => void;
    onRemoveRoute: (routeIndex: number) => void;
}) {
    // Nothing is numbered on screen any more, but two rows must still be
    // distinguishable to a screen reader — so the position is kept as the
    // fallback name for a step that has not been given one yet.
    const label = operation.name.trim() || `untitled step ${index + 1}`;

    return (
        <li
            draggable={drag.armed}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onResetDrag}
            className={`rounded-xl border bg-overlay p-3 transition-colors ${reordered ? "border-primary/40 bg-primary-subtle/30" : "border-border"
                } ${selected ? "ring-2 ring-primary/60" : ""} ${drag.isDragging ? "opacity-40" : ""
                } ${drag.landing ? "ring-2 ring-primary" : ""} ${drag.dropBefore ? "border-t-2 border-t-primary" : ""
                } ${drag.dropAfter ? "border-b-2 border-b-primary" : ""}`}
        >
            <div className="flex items-center gap-2">
                <Button
                    intent="plain"
                    size="sq-xs"
                    className="cursor-grab active:cursor-grabbing"
                    onPointerDown={onArmDrag}
                    onPointerUp={onResetDrag}
                    aria-label={`Reorder ${label}`}
                >
                    <Bars2Icon />
                </Button>

                <TextField
                    aria-label={`Name of ${label}`}
                    className="min-w-0 flex-1"
                    value={operation.name}
                    onChange={(name) => onPatch({ name })}
                >
                    <Input placeholder="Operation name" />
                </TextField>

                {reordered && <Badge intent="primary">Moved</Badge>}

                {/* Kept alongside the drag handle on purpose: dragging is a mouse
                    gesture, and these are the only way to reorder the chain from
                    the keyboard. */}
                <Button
                    intent="plain"
                    size="sq-xs"
                    onPress={() => onMove(-1)}
                    isDisabled={index === 0}
                    aria-label={`Move ${label} earlier`}
                >
                    <ArrowUpIcon />
                </Button>
                <Button
                    intent="plain"
                    size="sq-xs"
                    onPress={() => onMove(1)}
                    isDisabled={index === total - 1}
                    aria-label={`Move ${label} later`}
                >
                    <ArrowDownIcon />
                </Button>
                <Button intent="plain" size="sq-xs" onPress={onRemove} aria-label={`Remove ${label}`}>
                    <TrashIcon />
                </Button>
            </div>

            <div className="mt-3 space-y-3">
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
                    onPatchRoute={onPatchRoute}
                    onAddRoute={onAddRoute}
                    onRemoveRoute={onRemoveRoute}
                />
            </div>
        </li>
    );
}
