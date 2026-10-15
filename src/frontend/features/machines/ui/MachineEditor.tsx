import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Link } from "@/components/ui/link";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { InfoTooltip } from "@/components/ui/tooltip";
import { useSaveShortcutLabel } from "@/core/keyboard/useSaveShortcut";
import { PanelControls } from "@/core/panels/PanelChrome";
import { ArrowUturnLeftIcon, CheckIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import {
    CATEGORIES_IN_USE_HINT,
    NO_CATEGORY,
    type MachineCategory,
    type MachineDraft,
    type MachineSummary,
    type MachineUsage,
    type SaveGate,
} from "../model/machine";
import { NewCategoryPopover } from "./NewCategoryPopover";

/** How many dependent jobs are listed before the rest are summarised. */
const MAX_LISTED_JOBS = 6;

const STATUS_LABEL = { open: "Open", planned: "Planned", done: "Done", archived: "Archived" } as const;

function formatTimestamp(value: string | undefined): string {
    if (!value) return "–";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "–" : date.toLocaleString();
}

/**
 * The machine form: name, category, salary, and the status / removal actions.
 *
 * Presentational. Every edit leaves through a callback; whether a save is
 * allowed comes in as `gate`, the same answer the Ctrl+S shortcut uses.
 */
export function MachineEditor({
    draft,
    selected,
    categories,
    allCategories,
    saving,
    dirty,
    gate,
    usage,
    notes,
    onDraftChange,
    onSave,
    onDiscard,
    onCancelNew,
    onToggleActive,
    onRemove,
}: {
    draft: MachineDraft;
    selected: MachineSummary | null;
    /** The categories the picker offers: those in use, plus the draft's own. */
    categories: MachineCategory[];
    /** Every category, so "New" can reuse an unlisted one rather than duplicate it. */
    allCategories: MachineCategory[];
    saving: boolean;
    /** Whether the draft differs from the machine as the API has it. */
    dirty: boolean;
    gate: SaveGate;
    /** Which jobs route work through this machine; null while that is still loading. */
    usage: MachineUsage | null;
    notes?: React.ReactNode;
    onDraftChange: (update: (draft: MachineDraft) => MachineDraft) => void;
    onSave: () => void;
    onDiscard: () => void;
    /** Leave an unsaved new machine; omitted when there is nothing to cancel. */
    onCancelNew?: () => void;
    /** Retire or restore the machine, depending on its current status. */
    onToggleActive: () => void;
    /** Hard-delete the machine; only offered once nothing depends on it. */
    onRemove: () => void;
}) {
    const shortcut = useSaveShortcutLabel();
    const editing = selected !== null && draft.id === selected.id;
    // Status is the saved one, not the draft's: it changes through its own
    // button and is written straight away, never as part of "Save changes".
    const machineActive = selected?.active ?? true;
    const operationCount = usage?.operationCount ?? 0;
    const blockedByOperations = operationCount > 0;
    const listedJobs = usage?.jobs.slice(0, MAX_LISTED_JOBS) ?? [];
    const unlistedJobs = (usage?.jobs.length ?? 0) - listedJobs.length;

    return (
        <Card className="min-h-full">
            <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2.5">
                    {editing ? "Edit machine" : "Add machine"}
                    {editing && (
                        <Badge intent={machineActive ? "success" : "secondary"}>
                            {machineActive ? "Active" : "Inactive"}
                        </Badge>
                    )}
                    {editing && (
                        <InfoTooltip label="What active means">
                            Only active machines are offered when routing new operations and are
                            used by the scheduler. Deactivating keeps the machine and its history.
                        </InfoTooltip>
                    )}
                    {/* Unsaved work is otherwise invisible until something tries
                        to navigate away and a dialog appears out of nowhere. */}
                    {dirty && (
                        <Badge intent="warning" role="status">
                            Unsaved changes
                        </Badge>
                    )}
                </CardTitle>
                <CardAction className="flex items-center gap-2">
                    {editing && (
                        // Activate reads green (a restore action); deactivate
                        // reads red, but much lighter than the remove button's
                        // solid danger so retiring never reads as removing.
                        <Button
                            intent="plain"
                            size="sm"
                            className={machineActive
                                ? "bg-danger/20 text-danger hover:bg-danger/30"
                                : "bg-success/20 text-success hover:bg-success/30"}
                            onPress={onToggleActive}
                            isDisabled={saving}
                        >
                            {machineActive ? "Deactivate" : "Activate"}
                        </Button>
                    )}
                    <PanelControls />
                </CardAction>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-5">
                {notes}

                <TextField
                    value={draft.name}
                    isInvalid={gate.invalidField === "name"}
                    onChange={(name) => onDraftChange((value) => ({ ...value, name }))}
                >
                    <Label>Machine name</Label>
                    <Input placeholder="e.g. Assembly station 2" autoComplete="off" />
                </TextField>
                <div className="flex flex-col gap-4 sm:flex-row">
                    {/* The label sits outside the Select: inside it, the
                        tooltip's button would be taken for the Select's own
                        trigger and open the dropdown instead. */}
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <span className="flex items-center gap-1">
                            <Label id="machine-category-label" className="font-medium">
                                Category
                            </Label>
                            <InfoTooltip label="Which categories are listed">
                                {CATEGORIES_IN_USE_HINT} Use New to add one, or to reuse one that is not listed.
                            </InfoTooltip>
                        </span>
                        <div className="flex items-center gap-2">
                            <Select
                                aria-labelledby="machine-category-label"
                                className="min-w-0 flex-1"
                                value={draft.categoryId ?? NO_CATEGORY}
                                onChange={(value) =>
                                    onDraftChange((current) => ({
                                        ...current,
                                        categoryId: value === NO_CATEGORY ? null : String(value),
                                    }))
                                }
                            >
                                <SelectTrigger />
                                <SelectContent>
                                    <SelectItem id={NO_CATEGORY} textValue="No category">No category</SelectItem>
                                    {categories.map((category) => (
                                        <SelectItem key={category.id} id={category.id} textValue={category.name}>
                                            {category.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <NewCategoryPopover
                                categories={allCategories}
                                isDisabled={saving}
                                onPicked={(category) =>
                                    onDraftChange((current) => ({ ...current, categoryId: category.id }))
                                }
                            />
                        </div>
                    </div>
                    <TextField
                        className="flex-1"
                        value={draft.salary}
                        isInvalid={gate.invalidField === "salary"}
                        onChange={(salary) => onDraftChange((value) => ({ ...value, salary }))}
                    >
                        <Label>Hourly salary</Label>
                        <Input inputMode="decimal" placeholder="Optional, e.g. 32.50" autoComplete="off" />
                    </TextField>
                </div>

                {editing && (
                    <section aria-labelledby="machine-usage-heading" className="border-t pt-4">
                        <h3 id="machine-usage-heading" className="font-semibold text-sm">
                            Used by
                        </h3>
                        {usage === null ? (
                            <p className="mt-1 text-muted-fg text-sm">Checking which jobs route work here…</p>
                        ) : usage.jobs.length === 0 ? (
                            <p className="mt-1 text-muted-fg text-sm">No job routes any operation to this machine.</p>
                        ) : (
                            <>
                                <p className="mt-1 text-muted-fg text-sm">
                                    {operationCount} {operationCount === 1 ? "operation" : "operations"} across{" "}
                                    {usage.jobs.length} {usage.jobs.length === 1 ? "job" : "jobs"} can run here.
                                </p>
                                <ul className="mt-2 divide-y rounded-lg border">
                                    {listedJobs.map((job) => (
                                        <li key={job.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                                            <Link
                                                href={`/manager/jobs?job=${encodeURIComponent(job.id)}`}
                                                className="min-w-0 truncate underline-offset-2 hover:underline"
                                            >
                                                {job.name}
                                            </Link>
                                            {job.backlogStatus !== "open" && (
                                                <Badge intent="secondary">{STATUS_LABEL[job.backlogStatus]}</Badge>
                                            )}
                                            <span className="ms-auto shrink-0 text-muted-fg text-xs tabular-nums">
                                                {job.operationCount} {job.operationCount === 1 ? "op" : "ops"}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                                <Link
                                    href={`/manager/jobs?machine=${encodeURIComponent(draft.id ?? "")}`}
                                    className="mt-2 inline-block text-sm underline"
                                >
                                    {unlistedJobs > 0
                                        ? `See all ${usage.jobs.length} jobs in the backlog`
                                        : "Open these jobs in the backlog"}
                                </Link>
                            </>
                        )}
                    </section>
                )}

                {editing && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-4 text-sm">
                        <dt className="text-muted-fg">Added</dt>
                        <dd>{formatTimestamp(selected?.created_at)}</dd>
                        <dt className="text-muted-fg">Last updated</dt>
                        <dd>{formatTimestamp(selected?.updated_at)}</dd>
                    </dl>
                )}

                <div className="mt-auto flex flex-wrap items-center justify-end gap-2.5 border-t pt-5">
                    {/* A disabled button with no reason beside it is a dead end. */}
                    {gate.reason !== null && (
                        <span
                            className={
                                gate.invalidField !== null
                                    ? "me-auto flex items-center gap-1.5 rounded-md bg-warning-subtle px-2.5 py-1.5 font-medium text-sm text-warning-subtle-fg"
                                    : "me-auto text-muted-fg text-sm"
                            }
                            role="status"
                        >
                            {gate.invalidField !== null && <ExclamationTriangleIcon className="size-4 shrink-0" />}
                            {gate.reason}
                        </span>
                    )}
                    {/* Only an inactive machine can be removed, so an active one
                        is not offered the button at all: deactivating comes first. */}
                    {editing && !machineActive && (
                        <span className="flex items-center gap-1">
                            {/* A disabled button takes no hover, so the reason
                                hangs off an icon beside it instead. */}
                            {blockedByOperations && (
                                <InfoTooltip label="Why this machine cannot be removed">
                                    {operationCount} {operationCount === 1 ? "operation is" : "operations are"} routed
                                    to this machine, so it cannot be removed. Re-route those operations before
                                    removing it.
                                </InfoTooltip>
                            )}
                            <Button
                                intent="danger"
                                onPress={onRemove}
                                isDisabled={saving || blockedByOperations}
                            >
                                Remove machine
                            </Button>
                        </span>
                    )}
                    {!draft.id && onCancelNew && (
                        <Button intent="plain" onPress={onCancelNew} isDisabled={saving}>
                            Cancel
                        </Button>
                    )}
                    {/* Always rendered, merely disabled while there is nothing
                        to discard, so Save never shifts sideways under the
                        pointer at the first keystroke. */}
                    {editing && (
                        <Button intent="outline" onPress={onDiscard} isDisabled={!dirty || saving}>
                            <ArrowUturnLeftIcon /> Discard changes
                        </Button>
                    )}
                    <Button
                        onPress={onSave}
                        isPending={saving}
                        isDisabled={!gate.canSave}
                        aria-keyshortcuts="Control+S Meta+S"
                    >
                        <CheckIcon /> {draft.id ? "Save changes" : "Add machine"}
                        {shortcut !== null && (
                            <kbd aria-hidden className="ms-1 font-sans text-[0.75em] opacity-70">
                                {shortcut}
                            </kbd>
                        )}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
