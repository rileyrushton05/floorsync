import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Note } from "@/components/ui/note";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { CheckIcon } from "@heroicons/react/24/outline";
import type { MachineCategory, MachineDraft, MachineSummary } from "../model/machine";

const NO_CATEGORY = "__none";

export function MachineEditor({
    draft,
    selected,
    categories,
    categoryNames,
    saving,
    assignedOperationCount,
    onDraftChange,
    onSave,
    onDeactivate,
    onRemove,
}: {
    draft: MachineDraft;
    selected: MachineSummary | null;
    categories: MachineCategory[];
    categoryNames: ReadonlyMap<string, string>;
    saving: boolean;
    /** Number of job-definition operation routes assigned to this machine. */
    assignedOperationCount: number;
    onDraftChange: (update: (draft: MachineDraft) => MachineDraft) => void;
    onSave: () => void;
    /** Retire or restore the machine, depending on its current status. */
    onDeactivate: () => void;
    /** Hard-delete the machine; the screen guards the assigned-operations case. */
    onRemove: () => void;
}) {
    const editing = Boolean(draft.id) && draft.id === selected?.id;
    const canToggleActive = editing && !saving;
    const blockedByOperations = canToggleActive && assignedOperationCount > 0;
    const machineActive = draft.active;
    return (
        <Card className="min-h-full">
            <CardHeader>
                <CardTitle className="flex items-center gap-2.5">
                    {draft.id ? "Edit machine" : "Add machine"}
                    {draft.id && (
                        <Badge intent={machineActive ? "success" : "secondary"}>
                            {machineActive ? "Active" : "Inactive"}
                        </Badge>
                    )}
                </CardTitle>
                {editing && (
                    <CardAction>
                        {/* Activate reads green (a restore action); deactivate
                            reads red, but much lighter than the remove button's
                            solid danger so retiring never reads as removing. */}
                        <Button
                            intent="plain"
                            size="sm"
                            className={machineActive
                                ? "bg-danger/20 text-danger hover:bg-danger/30"
                                : "bg-success/20 text-success hover:bg-success/30"}
                            onPress={onDeactivate}
                            isDisabled={saving}
                        >
                            {machineActive ? "Deactivate" : "Activate"}
                        </Button>
                    </CardAction>
                )}
            </CardHeader>
            {/* Fill the card: the fields stretch edge to edge instead of the
                previous `max-w-xl` column that left the right half empty. */}
            <CardContent className="flex flex-1 flex-col space-y-5">
                <Note intent="info">This screen shows only fields stored by the machine API. A machine is retired by setting it inactive; the API intentionally does not delete machine history.</Note>
                <TextField value={draft.name} onChange={(name) => onDraftChange((value) => ({ ...value, name }))}>
                    <Label>Machine name</Label><Input placeholder="e.g. Assembly station 2" autoComplete="off" />
                </TextField>
                <Select value={draft.categoryId ?? NO_CATEGORY} onChange={(value) => onDraftChange((current) => ({ ...current, categoryId: value === NO_CATEGORY ? null : String(value) }))}>
                    <Label>Category</Label><SelectTrigger />
                    <SelectContent>
                        <SelectItem id={NO_CATEGORY}>No category</SelectItem>
                        {categories.map((category) => <SelectItem key={category.id} id={category.id} textValue={category.name}>{category.name}</SelectItem>)}
                    </SelectContent>
                </Select>
                <TextField value={draft.salary} onChange={(salary) => onDraftChange((value) => ({ ...value, salary }))}>
                    <Label>Hourly salary</Label><Input inputMode="decimal" placeholder="Optional" />
                </TextField>
                {draft.id && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-4 text-sm"><dt className="text-muted-fg">Created</dt><dd>{new Date(selected?.created_at ?? "").toLocaleString()}</dd><dt className="text-muted-fg">Category</dt><dd>{draft.categoryId ? categoryNames.get(draft.categoryId) ?? draft.categoryId : "None"}</dd></dl>}
                {blockedByOperations && (
                    <Note intent="warning" className="mt-auto">
                        This machine has {assignedOperationCount} assigned operation{assignedOperationCount === 1 ? "" : "s"}. Unassign or re-route them before removing it.
                    </Note>
                )}
                <div className="flex flex-wrap items-center justify-end gap-2.5 border-t pt-5">
                    {draft.id && (
                        <Button intent="danger" onPress={onRemove} isDisabled={saving || blockedByOperations || machineActive}>
                            Remove machine
                        </Button>
                    )}
                    <Button onPress={onSave} isPending={saving}><CheckIcon /> {draft.id ? "Save changes" : "Add machine"}</Button>
                </div>
            </CardContent>
        </Card>
    );
}
