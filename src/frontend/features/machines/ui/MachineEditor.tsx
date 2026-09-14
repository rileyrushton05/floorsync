import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    onDraftChange,
    onSave,
    onDeactivate,
}: {
    draft: MachineDraft;
    selected: MachineSummary | null;
    categories: MachineCategory[];
    categoryNames: ReadonlyMap<string, string>;
    saving: boolean;
    onDraftChange: (update: (draft: MachineDraft) => MachineDraft) => void;
    onSave: () => void;
    onDeactivate: () => void;
}) {
    return (
        <Card>
            <CardHeader><CardTitle>{draft.id ? "Edit machine" : "Add machine"}</CardTitle></CardHeader>
            <CardContent className="max-w-xl space-y-5">
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
                <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div><p className="font-medium text-sm">Available to the scheduler</p><p className="text-muted-fg text-xs">Inactive machines are kept as history but excluded from scheduling.</p></div>
                    <Button intent={draft.active ? "success" : "outline"} size="sm" onPress={() => onDraftChange((value) => ({ ...value, active: !value.active }))}>{draft.active ? "Active" : "Inactive"}</Button>
                </div>
                {draft.id && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-4 text-sm"><dt className="text-muted-fg">ID</dt><dd className="break-all">{draft.id}</dd><dt className="text-muted-fg">Created</dt><dd>{new Date(selected?.created_at ?? "").toLocaleString()}</dd><dt className="text-muted-fg">Category</dt><dd>{draft.categoryId ? categoryNames.get(draft.categoryId) ?? draft.categoryId : "None"}</dd></dl>}
                <div className="flex flex-wrap justify-between gap-3 border-t pt-5">
                    {selected?.active && draft.id === selected.id ? <Button intent="danger" onPress={onDeactivate} isDisabled={saving}>Deactivate</Button> : <span />}
                    <Button onPress={onSave} isPending={saving}><CheckIcon /> {draft.id ? "Save changes" : "Add machine"}</Button>
                </div>
            </CardContent>
        </Card>
    );
}
