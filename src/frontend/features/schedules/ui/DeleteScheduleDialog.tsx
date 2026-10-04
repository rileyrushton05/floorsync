import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Modal as AriaModal, ModalOverlay } from "react-aria-components";

/**
 * Confirm permanently removing a schedule.
 *
 * Same shell as the Machines page's remove confirmation and the Jobs page's
 * delete dialog: darkened, blurred backdrop, panel zooming in on open and out
 * on dismiss (`closing` keeps it mounted for the length of the zoom-out).
 */
export function DeleteScheduleDialog({ scheduleLabel, closing, deleting = false, onConfirm, onDismiss }: {
    scheduleLabel: string;
    closing: boolean;
    deleting?: boolean;
    onConfirm: () => void;
    onDismiss: () => void;
}) {
    return (
        <ModalOverlay
            isOpen
            isDismissable={!closing && !deleting}
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
                        <DialogTitle>Delete {scheduleLabel}?</DialogTitle>
                        <DialogDescription>
                            This permanently removes the draft and its plan. The jobs it planned
                            stay open in the backlog. This cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button intent="outline" onPress={onDismiss} isDisabled={deleting}>Cancel</Button>
                        <Button intent="danger" onPress={onConfirm} isPending={deleting}>Delete draft</Button>
                    </DialogFooter>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
