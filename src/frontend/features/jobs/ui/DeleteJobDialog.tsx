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
 * Confirm removing a job and its operations.
 *
 * The job is named, never identified by id: the manager never sees a UUID
 * anywhere else on this screen, so quoting one here would ask them to confirm
 * against a string they have no way to recognise. The sequence number comes
 * along because job names are not unique.
 *
 * `closing` keeps the dialog mounted for the length of the zoom-out; the
 * animation utilities come from `tw-animate-css`, already imported by
 * `app/styles.css`, rather than a `<style>` block re-injected on every render.
 */
export function DeleteJobDialog({ jobName, sequenceNumber, closing, onConfirm, onDismiss }: {
    jobName: string;
    sequenceNumber: number | undefined;
    closing: boolean;
    onConfirm: () => void;
    onDismiss: () => void;
}) {
    const label = jobName.trim() === "" ? "this job" : `“${jobName}”`;

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
                        <DialogTitle>
                            Delete {label}
                            {sequenceNumber !== undefined && (
                                <span className="text-muted-fg"> (#{sequenceNumber})</span>
                            )}?
                        </DialogTitle>
                        <DialogDescription>
                            This removes the job and all of its operations from the backlog. This cannot
                            be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button intent="outline" onPress={onDismiss}>Cancel</Button>
                        <Button intent="danger" onPress={onConfirm}>Delete job</Button>
                    </DialogFooter>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
