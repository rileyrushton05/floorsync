import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { Modal as AriaModal, ModalOverlay } from "react-aria-components";
import { useState } from "react";

/**
 * Strong confirmation for deleting an archived schedule.
 *
 * Deleting a retired run removes its history from any rollback lineage, so a
 * single click is not enough: the manager must type the schedule's name
 * (falling back to the short ID when unnamed) exactly, same pattern as
 * "type the repository name" confirmations elsewhere.
 */
export function DeleteArchivedScheduleDialog({ scheduleName, closing, onConfirm, onDismiss }: {
    /** The name to type back, already falling back to the short ID. */
    scheduleName: string;
    closing: boolean;
    onConfirm: () => void;
    onDismiss: () => void;
}) {
    const [typed, setTyped] = useState("");
    const confirmed = typed.trim() === scheduleName;

    return (
        <ModalOverlay
            isOpen
            isDismissable={!closing}
            onOpenChange={(open) => { if (!open) onDismiss(); }}
            className={`fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-5 backdrop-blur-sm duration-150 ${closing ? "animate-out fade-out-0" : "animate-in fade-in-0"
                }`}
        >
            <AriaModal
                className={`w-full max-w-sm rounded-2xl border bg-overlay shadow-lg duration-150 ${closing ? "animate-out fade-out-0 zoom-out-95" : "animate-in fade-in-0 zoom-in-95"
                    }`}
            >
                <Dialog role="alertdialog">
                    <DialogHeader>
                        <DialogTitle>Delete “{scheduleName}”?</DialogTitle>
                        <DialogDescription>
                            This permanently removes the schedule and its history, including any
                            rollback lineage that points at it. This cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (confirmed) onConfirm();
                        }}
                        className="px-(--gutter) pb-(--gutter)"
                    >
                        <TextField
                            aria-label="Type the schedule name to confirm"
                            value={typed}
                            onChange={setTyped}
                            className="block"
                        >
                            <Input
                                placeholder={`Type “${scheduleName}” to confirm`}
                                autoComplete="off"
                            />
                        </TextField>
                        <DialogFooter className="mt-4">
                            <Button intent="outline" onPress={onDismiss}>Cancel</Button>
                            <Button intent="danger" type="submit" isDisabled={!confirmed}>
                                Delete schedule
                            </Button>
                        </DialogFooter>
                    </form>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
