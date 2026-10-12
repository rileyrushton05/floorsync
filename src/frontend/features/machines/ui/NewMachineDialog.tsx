import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogBody,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { InfoTooltip } from "@/components/ui/tooltip";
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { Modal as AriaModal, ModalOverlay } from "react-aria-components";
import { toast } from "sonner";
import { useMachineCategories, useMachines, useSaveMachine } from "../data/queries";
import {
    CATEGORIES_IN_USE_HINT,
    categoriesInUse,
    draftProblem,
    EMPTY_MACHINE_DRAFT,
    machineInputFromDraft,
    NO_CATEGORY,
    type MachineDraft,
    type MachineSummary,
} from "../model/machine";
import { NewCategoryPopover } from "./NewCategoryPopover";

/**
 * Add a machine to the floor without leaving the screen you are on.
 *
 * Made for the job editor: routing a step is usually when a manager finds out
 * the machine it needs does not exist yet, and walking over to the machines
 * page and back loses their place. The fields are the machines page's "Add
 * machine" form, checked by the same rules, and the saved machine is handed
 * back so the caller can put it straight to use.
 */
export function NewMachineDialog({ onCreated, onDismiss }: {
    onCreated: (machine: MachineSummary) => void;
    onDismiss: () => void;
}) {
    const machineQuery = useMachines();
    const categoryQuery = useMachineCategories();
    const saveMachine = useSaveMachine();
    const [draft, setDraft] = useState<MachineDraft>(EMPTY_MACHINE_DRAFT);
    // Set as soon as the machine is sent. The save refetches the machine list
    // before it settles here, so the form would otherwise find its own new
    // machine and flash "already called" for an instant while it closes.
    const [submitted, setSubmitted] = useState(false);
    const saving = saveMachine.isPending || submitted;

    const machines = useMemo(() => machineQuery.data ?? [], [machineQuery.data]);
    const allCategories = useMemo(() => categoryQuery.data ?? [], [categoryQuery.data]);
    const categories = useMemo(
        () => categoriesInUse(allCategories, machines, draft.categoryId),
        [allCategories, draft.categoryId, machines],
    );
    // Held back until a name is typed: an empty form has nothing wrong with it yet.
    const problem = draft.name.trim() === "" || submitted ? null : draftProblem(draft, machines);
    const canSave = draft.name.trim() !== "" && problem === null && !saving;

    async function save() {
        if (!canSave) return;
        setSubmitted(true);
        try {
            const saved = await saveMachine.mutateAsync({ id: null, values: machineInputFromDraft(draft) });
            toast.success(`“${saved.name}” added to the floor.`, {
                description: "Its operator login was created with the default password. Manage it in Settings.",
            });
            onCreated(saved);
        } catch (error) {
            setSubmitted(false);
            reportMutationError(error);
        }
    }

    return (
        <ModalOverlay
            isOpen
            isDismissable={!saving}
            onOpenChange={(open) => { if (!open) onDismiss(); }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-5 backdrop-blur-sm duration-150 animate-in fade-in-0"
        >
            <AriaModal className="w-full max-w-md rounded-2xl border bg-overlay shadow-lg duration-150 animate-in fade-in-0 zoom-in-95">
                <Dialog>
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            void save();
                        }}
                    >
                        <DialogHeader>
                            <DialogTitle>New machine</DialogTitle>
                            <DialogDescription>
                                Added to the floor as an active machine and assigned to this row.
                                Nothing about the job itself is saved until you save the job.
                            </DialogDescription>
                        </DialogHeader>
                        <DialogBody className="gap-4">
                            <TextField
                                autoFocus
                                value={draft.name}
                                isInvalid={problem?.field === "name"}
                                onChange={(name) => setDraft((current) => ({ ...current, name }))}
                                isDisabled={saving}
                            >
                                <Label>Machine name</Label>
                                <Input placeholder="e.g. Assembly station 2" autoComplete="off" />
                            </TextField>
                            {/* Label kept outside the Select for the same reason as
                                the machines page: the tooltip's button would
                                otherwise be taken for the Select's trigger. */}
                            <div className="flex min-w-0 flex-col gap-2">
                                <span className="flex items-center gap-1">
                                    <Label id="new-machine-category-label" className="font-medium">
                                        Category
                                    </Label>
                                    <InfoTooltip label="Which categories are listed">
                                        {CATEGORIES_IN_USE_HINT} Use New to add one, or to reuse one that is not listed.
                                    </InfoTooltip>
                                </span>
                                <div className="flex items-center gap-2">
                                    <Select
                                        aria-labelledby="new-machine-category-label"
                                        className="min-w-0 flex-1"
                                        value={draft.categoryId ?? NO_CATEGORY}
                                        isDisabled={saving}
                                        onChange={(value) =>
                                            setDraft((current) => ({
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
                                            setDraft((current) => ({ ...current, categoryId: category.id }))
                                        }
                                    />
                                </div>
                            </div>
                            <TextField
                                value={draft.salary}
                                isInvalid={problem?.field === "salary"}
                                onChange={(salary) => setDraft((current) => ({ ...current, salary }))}
                                isDisabled={saving}
                            >
                                <Label>Hourly salary</Label>
                                <Input inputMode="decimal" placeholder="Optional, e.g. 32.50" autoComplete="off" />
                            </TextField>
                            {problem !== null && (
                                <p
                                    className="flex items-center gap-1.5 rounded-md bg-warning-subtle px-2.5 py-1.5 font-medium text-sm text-warning-subtle-fg"
                                    role="status"
                                >
                                    <ExclamationTriangleIcon className="size-4 shrink-0" />
                                    {problem.message}
                                </p>
                            )}
                        </DialogBody>
                        <DialogFooter>
                            <Button intent="outline" onPress={onDismiss} isDisabled={saving}>Cancel</Button>
                            <Button type="submit" isPending={saving} isDisabled={!canSave}>Add machine</Button>
                        </DialogFooter>
                    </form>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
