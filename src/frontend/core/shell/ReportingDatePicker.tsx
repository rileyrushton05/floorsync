"use client";

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
import { Popover, PopoverContent } from "@/components/ui/popover";
import { CalendarIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { getLocalTimeZone, type CalendarDate } from "@internationalized/date";
import { useReportingDate } from "./ReportingDate";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatShortDate(date: Date): string {
    return `${WEEKDAY_SHORT[date.getDay()]}, ${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`;
}

/**
 * The "Wed, 16 Sep" calendar control every manager page carries in its header,
 * beside the section name. It is the only way to change the reporting date, so
 * it is what lets a manager plan a day other than today.
 *
 * No min/max bounds: every month is navigable and every past or future day is
 * clickable — the previous seeded-fortnight bounds were why the arrows and
 * most cells appeared dead.
 */
export function ReportingDatePicker() {
    const { date: value, setDate: onChange } = useReportingDate();
    return (
        <Popover>
            <Button intent="outline" size="sm" aria-label="Pick reporting date" className="whitespace-nowrap">
                <CalendarIcon />
                {formatShortDate(value.toDate(getLocalTimeZone()))}
            </Button>
            <PopoverContent className="sm:max-w-none">
                <Calendar
                    aria-label="Reporting date"
                    value={value}
                    onChange={(date) => onChange(date as CalendarDate)}
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
                            {(date) => <CalendarWeekdayHeader />}
                        </CalendarGridHeader>
                        <CalendarGridBody>
                            {(date) => (
                                <CalendarCell date={date}>{date.day}</CalendarCell>
                            )}
                        </CalendarGridBody>
                    </CalendarGrid>
                </Calendar>
            </PopoverContent>
        </Popover>
    );
}
