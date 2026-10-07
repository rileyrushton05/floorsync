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
 * Confirm removing a machine outright.
 *
 * The machine is named, never identified by id: the manager never sees a UUID
 * anywhere else on this screen, so quoting one here would ask them to confirm
 * against a string they have no way to recognise.
 */
export function DeleteMachineDialog({ machineName, closing, onConfirm, onDismiss }: {
    machineName: string;
    closing: boolean;
    onConfirm: () => void;
    onDismiss: () => void;
}) {
    const label = machineName.trim() === "" ? "this machine" : `“${machineName}”`;

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
                        <DialogTitle>Remove {label}?</DialogTitle>
                        <DialogDescription>
                            This permanently removes the machine, its capability records and its
                            operator login. A machine that operations are still assigned to cannot be
                            removed.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button intent="outline" onPress={onDismiss}>Cancel</Button>
                        <Button intent="danger" onPress={onConfirm}>Remove machine</Button>
                    </DialogFooter>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
