"use client";

import { useEffect, useRef } from "react";
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
 * The step the graph currently has open, edited just below it.
 *
 * A panel rather than a dialog on purpose: the point of editing from the graph
 * is watching the graph answer. A modal would cover the very thing the edit is
 * about — rename a step or change what it waits on and the shape above you
 * redraws as you type, which a dialog would hide behind itself.
 *
 * It sits under the graph rather than beside it so both get the card's full
 * width: the graph scrolls sideways and wants every pixel across, and a step
 * with many machines reads far better as table rows than as a narrow column.
 *
 * It holds no state — every control writes straight to the job draft, which is
 * what the graph renders from, so the picture and the fields cannot disagree.
 *
 * Focus is placed only when a step was *just added* — `autoFocusName`. React's
 * own `autoFocus` fires on mount, and this panel stays mounted across
 * selections, so it used to focus the first step opened and none of the rest.
 * Focusing on every selection would be worse than either: the graph's nodes are
 * buttons, and keyboard traversal would throw the cursor into a text field on
 * each arrow press.
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
    autoFocusName,
    foreignPredecessors,
    machines,
    activeMachines,
    saving,
    readOnly = false,
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
    /** True only for a step that was just added, which lands unnamed. */
    autoFocusName: boolean;
    /** How many operations in *other* jobs this step waits on. Not editable here. */
    foreignPredecessors: number;
    machines: Machine[];
    activeMachines: Machine[];
    saving: boolean;
    /** The job is archived: this panel reads it out rather than editing it. */
    readOnly?: boolean;
    predecessorOptions: PredecessorOption[];
    onPatch: (patch: Partial<Pick<OperationDef, "name">>) => void;
    onDependenciesChange: (predecessorIds: string[]) => void;
    onPatchRoute: (routeIndex: number, patch: Partial<OperationDef["routes"][number]>) => void;
    onAddRoute: () => void;
    onRemoveRoute: (routeIndex: number) => void;
    onRemove: () => void;
}) {
    const nameRef = useRef<HTMLInputElement>(null);
    const operationId = operation?.id ?? null;

    useEffect(() => {
        if (autoFocusName) nameRef.current?.focus();
    }, [autoFocusName, operationId]);

    if (operation === null) {
        return (
            <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed p-5 text-center text-muted-fg text-sm">
                Select a step in the graph to {readOnly ? "see its details" : "edit it"} here.
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
                {!readOnly && (
                    <Button
                        intent="danger"
                        size="sq-xs"
                        onPress={onRemove}
                        aria-label={`Remove ${label}`}
                        className="[--btn-icon-active:var(--color-white)] [--btn-icon:var(--color-white)]"
                    >
                        <TrashIcon />
                    </Button>
                )}
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)] lg:items-start">
                <div className="flex flex-col gap-3">
                    <TextField
                        value={operation.name}
                        isReadOnly={readOnly}
                        onChange={(name) => onPatch({ name })}
                    >
                        <Label className="text-muted-fg text-xs">Step name</Label>
                        <Input ref={nameRef} placeholder="Operation name" autoComplete="off" />
                    </TextField>

                    <PredecessorPicker
                        label={label}
                        options={predecessorOptions}
                        selected={operation.dependsOn}
                        foreignPredecessors={foreignPredecessors}
                        readOnly={readOnly}
                        onChange={onDependenciesChange}
                    />
                </div>

                <OperationRoutes
                    routes={operation.routes}
                    machines={machines}
                    activeMachines={activeMachines}
                    saving={saving}
                    label={label}
                    readOnly={readOnly}
                    onPatchRoute={onPatchRoute}
                    onAddRoute={onAddRoute}
                    onRemoveRoute={onRemoveRoute}
                />
            </div>
        </div>
    );
}
