import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { useEffect, useRef, useState } from "react";
import { Modal as AriaModal, ModalOverlay } from "react-aria-components";
import { SCHEDULE_NAME_MAX } from "../model/archive";

/**
 * Name a schedule ("Friday morning plan", "Week 47 baseline").
 *
 * Small modal rather than an inline edit: the header it edits sits above the
 * Gantt preview, so typing inline would push the plan around under the
 * manager's eyes. Opens prefilled with the current name, selection placed so
 * typing replaces it in one stroke.
 */
export function RenameScheduleDialog({ currentName, isPending, onSave, onDismiss }: {
    currentName: string;
    isPending: boolean;
    onSave: (name: string) => void;
    onDismiss: () => void;
}) {
    const [name, setName] = useState(currentName);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        inputRef.current?.select();
    }, []);

    function save() {
        if (isPending) return;
        onSave(name);
    }

    return (
        <ModalOverlay
            isOpen
            isDismissable={!isPending}
            onOpenChange={(open) => { if (!open) onDismiss(); }}
            className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-fg/40 fade-in-0 p-5 backdrop-blur-sm duration-150"
        >
            <AriaModal className="w-full max-w-72 animate-in rounded-2xl border bg-overlay fade-in-0 shadow-lg duration-150 zoom-in-95">
                <Dialog role="dialog" className="[--gutter:--spacing(4)]">
                    <DialogHeader>
                        <DialogTitle>Rename schedule</DialogTitle>
                    </DialogHeader>
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            save();
                        }}
                        className="px-4 pb-4"
                    >
                        <TextField
                            aria-label="Schedule name"
                            value={name}
                            onChange={setName}
                            className="block"
                        >
                            <Input
                                ref={inputRef}
                                placeholder="e.g. Friday morning plan"
                                autoComplete="off"
                                maxLength={SCHEDULE_NAME_MAX}
                            />
                        </TextField>
                        <div className="mt-4 flex justify-end gap-2">
                            <Button intent="outline" onPress={onDismiss} isDisabled={isPending}>Cancel</Button>
                            <Button intent="primary" type="submit" isPending={isPending}>Save</Button>
                        </div>
                    </form>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
