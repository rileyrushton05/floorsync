"use client";

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
 * A blocking yes/no question.
 *
 * `role="alertdialog"` and a non-dismissable overlay are deliberate: every use
 * of this is a fork the person has to answer, and letting a click on the
 * backdrop count as "cancel" makes losing work one stray click away.
 */
export function ConfirmDialog({
    title,
    description,
    confirmLabel,
    cancelLabel = "Cancel",
    danger = false,
    onConfirm,
    onCancel,
}: {
    title: React.ReactNode;
    description: React.ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <ModalOverlay
            isOpen
            onOpenChange={(open) => {
                if (!open) onCancel();
            }}
            className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-fg/40 fade-in-0 p-5 backdrop-blur-sm duration-150"
        >
            <AriaModal className="w-full max-w-sm animate-in rounded-2xl border bg-overlay fade-in-0 shadow-lg duration-150 zoom-in-95">
                <Dialog role="alertdialog">
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        <DialogDescription>{description}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button intent="outline" onPress={onCancel}>
                            {cancelLabel}
                        </Button>
                        <Button intent={danger ? "danger" : "primary"} onPress={onConfirm}>
                            {confirmLabel}
                        </Button>
                    </DialogFooter>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
