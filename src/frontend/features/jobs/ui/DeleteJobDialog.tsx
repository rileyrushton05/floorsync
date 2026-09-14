import { Button } from "@/components/ui/button";
import { Modal as AriaModal, ModalOverlay } from "react-aria-components";

export function DeleteJobDialog({ jobId, closing, onConfirm, onDismiss }: {
    jobId: string;
    closing: boolean;
    onConfirm: () => void;
    onDismiss: () => void;
}) {
    return (
        <ModalOverlay isOpen isDismissable={!closing} onOpenChange={(open) => { if (!open) onDismiss(); }} className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5 backdrop-blur-sm ${closing ? "animate-[fade-out_150ms_ease-in_forwards]" : "animate-[fade-in_150ms_ease-out]"}`}>
            <style>{`@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } } @keyframes fade-out { from { opacity: 1 } to { opacity: 0 } } @keyframes zoom-in { from { opacity: 0; transform: scale(0.92) } to { opacity: 1; transform: scale(1) } } @keyframes zoom-out { from { opacity: 1; transform: scale(1) } to { opacity: 0; transform: scale(0.92) } }`}</style>
            <AriaModal aria-label={`Confirm delete ${jobId}`} className={`w-full max-w-sm rounded-2xl border bg-overlay p-5 shadow-lg ${closing ? "animate-[zoom-out_150ms_ease-in_forwards]" : "animate-[zoom-in_150ms_ease-out]"}`}>
                <h2 className="font-semibold text-fg text-lg">Delete {jobId}?</h2>
                <p className="mt-2 text-muted-fg text-sm">This removes the job and all of its operations from the backlog. This cannot be undone.</p>
                <div className="mt-5 flex items-center justify-end gap-2.5"><Button intent="outline" onPress={onDismiss}>Cancel</Button><Button intent="danger" onPress={onConfirm}>Delete job</Button></div>
            </AriaModal>
        </ModalOverlay>
    );
}
