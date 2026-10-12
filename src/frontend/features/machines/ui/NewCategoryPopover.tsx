import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverBody, PopoverContent, PopoverFooter, PopoverHeader, PopoverTitle } from "@/components/ui/popover";
import { TextField } from "@/components/ui/text-field";
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { toast } from "sonner";
import { useCreateMachineCategory } from "../data/queries";
import { existingCategory, type MachineCategory } from "../model/machine";

/**
 * A small "New category" form that opens beside the category picker.
 *
 * Categories are only ever needed at the moment a machine is being filed
 * under one, so they are created here rather than on a screen of their own.
 * The category is handed back so the caller can select it at once.
 *
 * `categories` is every category, not just the ones the picker shows: a name
 * matching one that no machine uses yet picks that one instead of creating it.
 */
export function NewCategoryPopover({
    categories,
    isDisabled,
    onPicked,
}: {
    categories: readonly MachineCategory[];
    isDisabled?: boolean;
    onPicked: (category: MachineCategory) => void;
}) {
    const createCategory = useCreateMachineCategory();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    // Set as soon as the name is sent. The category reaches the list before
    // the request settles here, so the form would otherwise flip to "already
    // exists" for an instant while the popover closes.
    const [submitted, setSubmitted] = useState(false);
    const existing = submitted ? null : existingCategory(name, categories);
    const canSubmit = name.trim() !== "" && !submitted;

    function changeOpen(next: boolean) {
        if (createCategory.isPending) return;
        setOpen(next);
        // Cleared on opening rather than closing, so the field does not
        // empty out in front of the manager while the popover fades away.
        if (next) {
            setName("");
            setSubmitted(false);
        }
    }

    async function submit() {
        if (!canSubmit) return;
        setSubmitted(true);
        if (existing) {
            setOpen(false);
            onPicked(existing);
            return;
        }
        try {
            const category = await createCategory.mutateAsync(name.trim());
            setOpen(false);
            onPicked(category);
            toast.success(`Category “${category.name}” added.`);
        } catch (error) {
            setSubmitted(false);
            reportMutationError(error);
        }
    }

    return (
        <Popover isOpen={open} onOpenChange={changeOpen}>
            <Button intent="outline" isDisabled={isDisabled} aria-label="Add a new category">
                <PlusIcon /> New
            </Button>
            <PopoverContent placement="bottom end" className="w-72">
                <Dialog aria-label="New category">
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            void submit();
                        }}
                    >
                        <PopoverHeader>
                            <PopoverTitle>New category</PopoverTitle>
                        </PopoverHeader>
                        <PopoverBody className="gap-1.5 pb-1">
                            <TextField
                                autoFocus
                                value={name}
                                onChange={setName}
                                isDisabled={createCategory.isPending}
                            >
                                <Label>Name</Label>
                                <Input placeholder="e.g. Cutting" autoComplete="off" />
                            </TextField>
                            {existing && (
                                <p className="text-muted-fg text-xs" role="status">
                                    “{existing.name}” already exists, so it will be selected.
                                </p>
                            )}
                        </PopoverBody>
                        <PopoverFooter>
                            <Button intent="plain" onPress={() => changeOpen(false)} isDisabled={createCategory.isPending}>
                                Cancel
                            </Button>
                            <Button type="submit" isPending={createCategory.isPending} isDisabled={!canSubmit}>
                                {existing ? "Use category" : "Add category"}
                            </Button>
                        </PopoverFooter>
                    </form>
                </Dialog>
            </PopoverContent>
        </Popover>
    );
}
