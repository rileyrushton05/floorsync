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
export function DeleteScheduleDialog({ scheduleLabel, closing, onConfirm, onDismiss }: {
    scheduleLabel: string;
    closing: boolean;
    onConfirm: () => void;
    onDismiss: () => void;
}) {
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
                        <DialogTitle>Delete {scheduleLabel}?</DialogTitle>
                        <DialogDescription>
                            This permanently removes the schedule. This cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button intent="outline" onPress={onDismiss}>Cancel</Button>
                        <Button intent="danger" onPress={onConfirm}>Delete schedule</Button>
                    </DialogFooter>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
