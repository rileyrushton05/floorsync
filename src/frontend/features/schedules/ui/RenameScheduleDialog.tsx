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
import { TextField } from "@/components/ui/text-field";
import { useState } from "react";
import { Modal as AriaModal, ModalOverlay } from "react-aria-components";
import { SCHEDULE_NAME_MAX } from "../model/archive";

/**
 * Give a saved schedule a new name.
 *
 * Same shell as the delete confirmation. The name is labelling only, so it can
 * change in any status, including on a schedule the floor is already running.
 */
export function RenameScheduleDialog({ currentName, saving, onSave, onDismiss }: {
    currentName: string | null;
    saving: boolean;
    onSave: (name: string) => void;
    onDismiss: () => void;
}) {
    const [name, setName] = useState(currentName ?? "");
    const trimmed = name.trim();
    const canSave = trimmed !== "" && trimmed !== (currentName ?? "") && !saving;

    return (
        <ModalOverlay
            isOpen
            isDismissable={!saving}
            onOpenChange={(open) => { if (!open) onDismiss(); }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-5 backdrop-blur-sm duration-150 animate-in fade-in-0"
        >
            <AriaModal className="w-full max-w-sm rounded-2xl border bg-overlay shadow-lg duration-150 animate-in fade-in-0 zoom-in-95">
                <Dialog>
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (canSave) onSave(trimmed);
                        }}
                    >
                        <DialogHeader>
                            <DialogTitle>{currentName ? "Rename schedule" : "Name this schedule"}</DialogTitle>
                            <DialogDescription>
                                The name is how this schedule is listed on the Schedules and Simulation pages.
                            </DialogDescription>
                        </DialogHeader>
                        <DialogBody>
                            <TextField
                                autoFocus
                                value={name}
                                onChange={setName}
                                maxLength={SCHEDULE_NAME_MAX}
                                isDisabled={saving}
                            >
                                <Label>Schedule name</Label>
                                <Input placeholder="e.g. Week 41 – day shift" autoComplete="off" />
                            </TextField>
                        </DialogBody>
                        <DialogFooter>
                            <Button intent="outline" onPress={onDismiss} isDisabled={saving}>Cancel</Button>
                            <Button type="submit" isPending={saving} isDisabled={!canSave}>Save name</Button>
                        </DialogFooter>
                    </form>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
