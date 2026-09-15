import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberField, NumberInput } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import type { Machine, OperationDef } from "@/domains/scheduling/types";
import {
    ArrowDownIcon,
    ArrowUpIcon,
    Bars2Icon,
    PlusIcon,
    TrashIcon,
    XMarkIcon,
} from "@heroicons/react/24/outline";

/** Drag state for one row, owned by the screen and handed down. */
export interface RowDragState {
    isDragging: boolean;
    dropBefore: boolean;
    dropAfter: boolean;
    landing: boolean;
    armed: boolean;
}

/**
 * One operation: its name, its position in the chain, and the machine routes
 * that can run it.
 *
 * The step marker is deliberately uniform rather than a green/amber/red run.
 * Position in a chain is not a health signal — a red badge on the final step
 * read as "this one has a problem" when it only ever meant "this one is last",
 * and on a two-step job every operation was simultaneously first-and-green and
 * last-and-red. Order is already carried by the number and by top-to-bottom
 * placement, so the marker stays neutral and the colour budget goes to the one
 * thing here that is genuinely a state: an unsaved reorder.
 */
export function OperationEditor({
    operation,
    index,
    total,
    machines,
    activeMachines,
    saving,
    reordered,
    drag,
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
    operation: OperationDef;
    index: number;
    total: number;
    machines: Machine[];
    activeMachines: Machine[];
    saving: boolean;
    reordered: boolean;
    drag: RowDragState;
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
    const routes = operation.routes;
    const canAddRoute = activeMachines.some(
        (machine) => !routes.some((route) => route.machineId === machine.id),
    );

    return (
        <li
            draggable={drag.armed}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onResetDrag}
            className={`rounded-xl border bg-overlay p-3 transition-colors ${reordered ? "border-primary/40 bg-primary-subtle/30" : "border-border"
                } ${drag.isDragging ? "opacity-40" : ""} ${drag.landing ? "ring-2 ring-primary" : ""
                } ${drag.dropBefore ? "border-t-2 border-t-primary" : ""} ${drag.dropAfter ? "border-b-2 border-b-primary" : ""
                }`}
        >
            <div className="flex items-center gap-2">
                <Button
                    intent="plain"
                    size="sq-xs"
                    className="cursor-grab active:cursor-grabbing"
                    onPointerDown={onArmDrag}
                    onPointerUp={onResetDrag}
                    aria-label={`Reorder operation ${index + 1}`}
                >
                    <Bars2Icon />
                </Button>
                <span
                    aria-hidden
                    className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-secondary font-semibold text-secondary-fg text-xs tabular-nums"
                >
                    {index + 1}
                </span>

                <TextField
                    aria-label={`Operation ${index + 1} name`}
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
                    aria-label={`Move operation ${index + 1} earlier`}
                >
                    <ArrowUpIcon />
                </Button>
                <Button
                    intent="plain"
                    size="sq-xs"
                    onPress={() => onMove(1)}
                    isDisabled={index === total - 1}
                    aria-label={`Move operation ${index + 1} later`}
                >
                    <ArrowDownIcon />
                </Button>
                <Button
                    intent="plain"
                    size="sq-xs"
                    onPress={onRemove}
                    aria-label={`Remove operation ${index + 1}`}
                >
                    <TrashIcon />
                </Button>
            </div>

            <div className="mt-3 rounded-lg border bg-muted p-3">
                <div className="mb-2.5 flex items-center justify-between gap-2">
                    <span className="font-semibold text-muted-fg text-xs uppercase tracking-[0.05em]">
                        Machines that can run this
                    </span>
                    <Button intent="outline" size="sm" onPress={onAddRoute} isDisabled={saving || !canAddRoute}>
                        <PlusIcon /> Add machine
                    </Button>
                </div>

                <ul className="space-y-2.5">
                    {routes.map((route, routeIndex) => {
                        const currentMachine = machines.find((machine) => machine.id === route.machineId);
                        return (
                            <li
                                key={`${route.machineId}-${routeIndex}`}
                                className="grid items-end gap-2.5 rounded-lg sm:grid-cols-[minmax(10rem,1fr)_8.5rem_8.5rem_auto]"
                            >
                                <Select
                                    className="min-w-0"
                                    value={route.machineId}
                                    onChange={(machineId) =>
                                        onPatchRoute(routeIndex, { machineId: String(machineId) })
                                    }
                                >
                                    <Label className="text-muted-fg text-xs">Machine</Label>
                                    <SelectTrigger />
                                    <SelectContent>
                                        {activeMachines.map((machine) => (
                                            <SelectItem
                                                key={machine.id}
                                                id={machine.id}
                                                textValue={machine.name}
                                                isDisabled={routes.some(
                                                    (existing, existingIndex) =>
                                                        existingIndex !== routeIndex &&
                                                        existing.machineId === machine.id,
                                                )}
                                            >
                                                {machine.name}
                                            </SelectItem>
                                        ))}
                                        {currentMachine && !currentMachine.active && (
                                            <SelectItem
                                                id={currentMachine.id}
                                                textValue={`${currentMachine.name} (inactive)`}
                                                isDisabled
                                            >
                                                {currentMachine.name} (inactive)
                                            </SelectItem>
                                        )}
                                    </SelectContent>
                                </Select>

                                <NumberField
                                    minValue={1}
                                    step={1}
                                    formatOptions={{ maximumFractionDigits: 0 }}
                                    value={route.durationMins}
                                    onChange={(durationMins) =>
                                        onPatchRoute(routeIndex, { durationMins: Math.round(durationMins) })
                                    }
                                >
                                    <Label className="text-muted-fg text-xs">Duration</Label>
                                    <NumberInput steppers={false} suffix="min" placeholder="30" />
                                </NumberField>

                                {/* NaN is React Aria's empty value for a NumberField, and the
                                    only one that keeps the field controlled — `undefined`
                                    silently makes it uncontrolled, so a blank energy would
                                    keep whatever was typed for the previously opened job.
                                    Clearing it stores null, which the database defines as
                                    "not recorded" rather than zero. */}
                                <NumberField
                                    minValue={0}
                                    step={0.1}
                                    value={route.energy === null ? Number.NaN : Number(route.energy)}
                                    onChange={(energy) =>
                                        onPatchRoute(routeIndex, {
                                            energy: Number.isNaN(energy) ? null : String(energy),
                                        })
                                    }
                                >
                                    <Label className="text-muted-fg text-xs">Energy</Label>
                                    <NumberInput steppers={false} suffix="kWh" placeholder="Optional" />
                                </NumberField>

                                <Button
                                    intent="plain"
                                    size="sq-xs"
                                    className="mb-1"
                                    onPress={() => onRemoveRoute(routeIndex)}
                                    isDisabled={saving || routes.length === 1}
                                    aria-label={`Remove ${currentMachine?.name ?? "machine"} from operation ${index + 1}`}
                                >
                                    <XMarkIcon />
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </li>
    );
}
