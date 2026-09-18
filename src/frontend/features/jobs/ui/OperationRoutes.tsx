import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { NumberField, NumberInput } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { Machine, OperationDef } from "@/domains/scheduling/types";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

/**
 * The machines that can run one step, and what each costs.
 *
 * Routes are alternatives, not parallel work — the scheduler picks one. Shared
 * by the operation card and the graph's side panel, so an edit made in either
 * place is the same edit rather than two implementations that drift.
 *
 * `stacked` lays the fields out in a column for the narrow side panel; the card
 * has room for a single row.
 *
 * `readOnly` is for an archived job: the routes still have to be legible — that
 * is most of what a manager opens a finished job to see — so the text fields
 * stay focusable and selectable rather than greying out. Only the controls that
 * would write are taken away.
 */
export function OperationRoutes({
    routes,
    machines,
    activeMachines,
    saving,
    label,
    stacked = false,
    readOnly = false,
    onPatchRoute,
    onAddRoute,
    onRemoveRoute,
}: {
    routes: OperationDef["routes"];
    machines: Machine[];
    activeMachines: Machine[];
    saving: boolean;
    label: string;
    stacked?: boolean;
    /** The job is archived: show the routes, offer no way to change them. */
    readOnly?: boolean;
    onPatchRoute: (routeIndex: number, patch: Partial<OperationDef["routes"][number]>) => void;
    onAddRoute: () => void;
    onRemoveRoute: (routeIndex: number) => void;
}) {
    const canAddRoute = activeMachines.some(
        (machine) => !routes.some((route) => route.machineId === machine.id),
    );

    return (
        <div className="rounded-lg border bg-muted p-3">
            <div className="mb-2.5 flex items-center justify-between gap-2">
                <span className="font-semibold text-muted-fg text-xs uppercase tracking-[0.05em]">
                    Machines that can run this
                </span>
                {!readOnly && (
                    <Button intent="outline" size="sm" onPress={onAddRoute} isDisabled={saving || !canAddRoute}>
                        <PlusIcon /> Add machine
                    </Button>
                )}
            </div>

            <ul className={stacked ? "space-y-3" : "space-y-2.5"}>
                {routes.map((route, routeIndex) => {
                    const currentMachine = machines.find((machine) => machine.id === route.machineId);
                    return (
                        <li
                            key={`${route.machineId}-${routeIndex}`}
                            className={
                                stacked
                                    ? "rounded-lg border bg-overlay p-2.5"
                                    : "grid items-end gap-2.5 rounded-lg sm:grid-cols-[minmax(10rem,1fr)_8.5rem_8.5rem_auto]"
                            }
                        >
                            <div className={stacked ? "flex items-end gap-2" : "contents"}>
                                <Select
                                    className="min-w-0 flex-1"
                                    value={route.machineId}
                                    isDisabled={readOnly}
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

                                {stacked && !readOnly && (
                                    <Button
                                        intent="plain"
                                        size="sq-xs"
                                        className="mb-1"
                                        onPress={() => onRemoveRoute(routeIndex)}
                                        isDisabled={saving || routes.length === 1}
                                        aria-label={`Remove ${currentMachine?.name ?? "machine"} from ${label}`}
                                    >
                                        <XMarkIcon />
                                    </Button>
                                )}
                            </div>

                            <div className={stacked ? "mt-2 grid grid-cols-2 gap-2" : "contents"}>
                                <NumberField
                                    minValue={1}
                                    step={1}
                                    isReadOnly={readOnly}
                                    formatOptions={{ maximumFractionDigits: 0 }}
                                    value={route.durationMins}
                                    onChange={(durationMins) =>
                                        onPatchRoute(routeIndex, { durationMins: Math.round(durationMins) })
                                    }
                                >
                                    <Label className="text-muted-fg text-xs">Duration</Label>
                                    {/* Clearing the field leaves NaN, which React Aria renders as
                                        empty — so the placeholder is what a manager reads back.
                                        It pairs with Energy's "Optional" to say which of the two
                                        the API will refuse without. */}
                                    <NumberInput steppers={false} suffix="min" placeholder="Required" />
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
                                    isReadOnly={readOnly}
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
                            </div>

                            {!stacked && !readOnly && (
                                <Button
                                    intent="plain"
                                    size="sq-xs"
                                    className="mb-1"
                                    onPress={() => onRemoveRoute(routeIndex)}
                                    isDisabled={saving || routes.length === 1}
                                    aria-label={`Remove ${currentMachine?.name ?? "machine"} from ${label}`}
                                >
                                    <XMarkIcon />
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
