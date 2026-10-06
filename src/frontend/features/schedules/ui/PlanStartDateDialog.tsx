import { Button } from "@/components/ui/button";
import {
    Calendar,
    CalendarCell,
    CalendarGrid,
    CalendarGridBody,
    CalendarGridHeader,
    CalendarHeader,
    CalendarNavButton,
    CalendarTitle,
    CalendarWeekdayHeader,
} from "@/components/ui/calendar";
import {
    Dialog,
    DialogBody,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { getLocalTimeZone, type CalendarDate } from "@internationalized/date";
import { useState } from "react";
import { Modal as AriaModal, ModalOverlay } from "react-aria-components";

function formatStartDate(date: CalendarDate): string {
    return date.toDate(getLocalTimeZone()).toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

/**
 * Ask which day a plan starts on, as the step between pressing Generate and
 * the request going out. The start date only matters to generation, so it is
 * chosen here rather than from a page-wide control.
 *
 * Same shell as the rename dialog. Opens on the day last used on this page, so
 * regenerating for the same day is one press.
 */
export function PlanStartDateDialog({ initialDate, regenerating, onGenerate, onDismiss }: {
    initialDate: CalendarDate;
    regenerating: boolean;
    onGenerate: (date: CalendarDate) => void;
    onDismiss: () => void;
}) {
    const [date, setDate] = useState(initialDate);

    return (
        <ModalOverlay
            isOpen
            isDismissable
            onOpenChange={(open) => { if (!open) onDismiss(); }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-5 backdrop-blur-sm duration-150 animate-in fade-in-0"
        >
            <AriaModal className="w-full max-w-sm rounded-2xl border bg-overlay shadow-lg duration-150 animate-in fade-in-0 zoom-in-95">
                <Dialog>
                    <DialogHeader>
                        <DialogTitle>When does this plan start?</DialogTitle>
                        <DialogDescription>
                            The plan&apos;s first operations are placed from the start of this day.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogBody className="items-center">
                        <Calendar
                            aria-label="Plan start date"
                            autoFocus
                            value={date}
                            onChange={(value) => setDate(value as CalendarDate)}
                        >
                            <CalendarHeader>
                                <CalendarNavButton slot="previous" aria-label="Previous month">
                                    <ChevronRightIcon className="size-4 rotate-180" />
                                </CalendarNavButton>
                                <CalendarTitle />
                                <CalendarNavButton slot="next" aria-label="Next month">
                                    <ChevronRightIcon className="size-4" />
                                </CalendarNavButton>
                            </CalendarHeader>
                            <CalendarGrid>
                                <CalendarGridHeader>
                                    {(day) => <CalendarWeekdayHeader>{day}</CalendarWeekdayHeader>}
                                </CalendarGridHeader>
                                <CalendarGridBody>
                                    {(day) => <CalendarCell date={day}>{day.day}</CalendarCell>}
                                </CalendarGridBody>
                            </CalendarGrid>
                        </Calendar>
                    </DialogBody>
                    <DialogFooter>
                        <Button intent="outline" onPress={onDismiss}>Cancel</Button>
                        <Button
                            onPress={() => onGenerate(date)}
                            aria-label={`${regenerating ? "Regenerate" : "Generate"} plan starting ${formatStartDate(date)}`}
                        >
                            {regenerating ? "Regenerate" : "Generate"} from {formatStartDate(date)}
                        </Button>
                    </DialogFooter>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
