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
import { categoryNameProblem, type MachineCategory } from "../model/machine";

/**
 * A small "New category" form that opens beside the category picker.
 *
 * Categories are only ever needed at the moment a machine is being filed
 * under one, so they are created here rather than on a screen of their own.
 * The created category is handed back so the caller can select it at once.
 */
export function NewCategoryPopover({
    categories,
    isDisabled,
    onCreated,
}: {
    categories: readonly MachineCategory[];
    isDisabled?: boolean;
    onCreated: (category: MachineCategory) => void;
}) {
    const createCategory = useCreateMachineCategory();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    // Only complain once something has been typed: an empty field the
    // manager has not touched yet is not a mistake.
    const problem = name === "" ? null : categoryNameProblem(name, categories);
    const canCreate = name.trim() !== "" && problem === null && !createCategory.isPending;

    function changeOpen(next: boolean) {
        if (createCategory.isPending) return;
        setOpen(next);
        if (!next) setName("");
    }

    async function submit() {
        if (!canCreate) return;
        try {
            const category = await createCategory.mutateAsync(name.trim());
            onCreated(category);
            toast.success(`Category “${category.name}” added.`);
            setOpen(false);
            setName("");
        } catch (error) {
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
                                isInvalid={problem !== null}
                                isDisabled={createCategory.isPending}
                            >
                                <Label>Name</Label>
                                <Input placeholder="e.g. Cutting" autoComplete="off" />
                            </TextField>
                            {problem !== null && (
                                <p className="text-danger text-xs" role="alert">
                                    {problem}
                                </p>
                            )}
                        </PopoverBody>
                        <PopoverFooter>
                            <Button intent="plain" onPress={() => changeOpen(false)} isDisabled={createCategory.isPending}>
                                Cancel
                            </Button>
                            <Button type="submit" isPending={createCategory.isPending} isDisabled={!canCreate}>
                                Add category
                            </Button>
                        </PopoverFooter>
                    </form>
                </Dialog>
            </PopoverContent>
        </Popover>
    );
}
