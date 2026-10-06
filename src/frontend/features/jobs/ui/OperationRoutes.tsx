import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { NumberField, NumberInput } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { Machine, OperationDef } from "@/domains/scheduling/types";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef } from "react";

/**
 * The machines that can run one step, and what each costs.
 *
 * Routes are alternatives, not parallel work — the scheduler picks one.
 *
 * Each machine is one table-like row under a single set of column headings.
 * A step can have twenty-plus machine variants, so the list scrolls inside a
 * fixed height with the headings and "Add machine" kept outside it. Fixed, not
 * just capped: from `lg` up it fills the rest of the step panel's fixed height
 * (below that, a fixed height of its own), so adding a machine — or opening a
 * step with more of them — never moves the save and discard buttons below it.
 * Adding a machine scrolls the new row into view instead.
 *
 * The row layout keys off this box's own width (a container query), not the
 * viewport's: beside the step's name and predecessors it can be far narrower
 * than the screen, and three fixed-width columns then ran out past its edge.
 * Too narrow for them, each route stacks its fields instead.
 *
 * `readOnly` is for an archived job: the routes still have to be legible — that
 * is most of what a manager opens a finished job to see — so the text fields
 * stay focusable and selectable rather than greying out. Only the controls that
 * would write are taken away.
 */
/** Shared by the heading row and every route row so the columns line up. */
const EDITABLE_COLUMNS = "@min-[28rem]:grid-cols-[minmax(0,1fr)_7rem_7rem_1.75rem]";
const READ_ONLY_COLUMNS = "@min-[28rem]:grid-cols-[minmax(0,1fr)_7rem_7rem]";

export function OperationRoutes({
    routes,
    machines,
    activeMachines,
    saving,
    label,
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
    /** The job is archived: show the routes, offer no way to change them. */
    readOnly?: boolean;
    onPatchRoute: (routeIndex: number, patch: Partial<OperationDef["routes"][number]>) => void;
    onAddRoute: () => void;
    onRemoveRoute: (routeIndex: number) => void;
}) {
    const canAddRoute = activeMachines.some(
        (machine) => !routes.some((route) => route.machineId === machine.id),
    );
    const columns = readOnly ? READ_ONLY_COLUMNS : EDITABLE_COLUMNS;

    // Only an add should scroll. The panel stays mounted across selections, so
    // watching the length alone would also jump to the bottom whenever a step
    // with more machines than the last one was opened.
    const listRef = useRef<HTMLUListElement>(null);
    const justAdded = useRef(false);
    useEffect(() => {
        if (!justAdded.current) return;
        justAdded.current = false;
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }, [routes.length]);

    return (
        <div className="@container flex min-h-0 min-w-0 flex-col rounded-lg border bg-muted p-2.5 sm:p-3">
            <div className="mb-2.5 flex items-center justify-between gap-2">
                <span className="font-semibold text-muted-fg text-xs uppercase tracking-[0.05em]">
                    Machines that can run this
                    {routes.length > 1 && <span className="ms-1.5 tabular-nums opacity-70">({routes.length})</span>}
                </span>
                {!readOnly && (
                    <Button
                        intent="outline"
                        size="sm"
                        onPress={() => {
                            justAdded.current = true;
                            onAddRoute();
                        }}
                        isDisabled={saving || !canAddRoute}
                    >
                        <PlusIcon /> Add machine
                    </Button>
                )}
            </div>

            {/* The per-field labels are kept for screen readers but hidden from
                the column layout up, where this one heading row says the same thing once
                rather than twenty times down a long list. */}
            <div aria-hidden className={`mb-1 hidden gap-2.5 ps-0.5 pe-[calc(0.5rem+14px)] text-muted-fg text-xs @min-[28rem]:grid ${columns}`}>
                <span>Machine</span>
                <span>Duration</span>
                <span>Energy</span>
            </div>

            {/* The gutter is reserved even when nothing overflows, so the heading
                row above (padded by the same scrollbar width) stays aligned whether
                or not the bar is showing. The small inset keeps focus rings from
                being clipped by the scroll container. */}
            <ul
                ref={listRef}
                className="scroll-rail h-40 sm:h-52 space-y-2.5 lg:h-auto lg:min-h-0 lg:flex-1 overflow-y-auto p-0.5 pe-2 [scrollbar-gutter:stable]"
            >
                {routes.map((route, routeIndex) => {
                    const currentMachine = machines.find((machine) => machine.id === route.machineId);
                    return (
                        <li
                            key={`${route.machineId}-${routeIndex}`}
                            className={`grid items-end gap-2.5 rounded-lg ${columns}`}
                        >
                            <Select
                                className="min-w-0"
                                value={route.machineId}
                                isDisabled={readOnly}
                                onChange={(machineId) =>
                                    onPatchRoute(routeIndex, { machineId: String(machineId) })
                                }
                            >
                                <Label className="text-muted-fg text-xs @min-[28rem]:sr-only">Machine</Label>
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
                                isReadOnly={readOnly}
                                formatOptions={{ maximumFractionDigits: 0 }}
                                value={route.durationMins}
                                onChange={(durationMins) =>
                                    onPatchRoute(routeIndex, { durationMins: Math.round(durationMins) })
                                }
                            >
                                <Label className="text-muted-fg text-xs @min-[28rem]:sr-only">Duration</Label>
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
                                <Label className="text-muted-fg text-xs @min-[28rem]:sr-only">Energy</Label>
                                <NumberInput steppers={false} suffix="kWh" placeholder="Optional" />
                            </NumberField>

                            {!readOnly && (
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
