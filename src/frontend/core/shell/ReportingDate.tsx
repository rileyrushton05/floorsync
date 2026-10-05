"use client";

import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { getLocalTimeZone, type CalendarDate } from "@internationalized/date";
import { todayValue } from "./ReportingDatePicker";

interface ReportingDateContextValue {
    date: CalendarDate;
    setDate: (date: CalendarDate) => void;
}

const ReportingDateContext = createContext<ReportingDateContextValue | null>(null);

/**
 * The reporting date every manager page shares through the topbar's calendar
 * control.
 *
 * The picker itself is rendered by `ManagerTopbar`, centred; this provider is
 * what makes the choice functional — the overview reads the date to slice its
 * fixture weeks, and any screen that later wants to react to the picked day
 * calls `useReportingDate()` rather than carrying its own second calendar.
 */
export function ReportingDateProvider({ children }: { children: ReactNode }) {
    const [date, setDate] = useState<CalendarDate>(todayValue);
    const value = useMemo(() => ({ date, setDate }), [date]);
    return <ReportingDateContext value={value}>{children}</ReportingDateContext>;
}

export function useReportingDate(): ReportingDateContextValue {
    const context = use(ReportingDateContext);
    if (context === null) throw new Error("useReportingDate must be used within ReportingDateProvider");
    return context;
}

/**
 * Convert the selected calendar day into the local start of that day for an
 * API datetime field. Keeping the numeric UTC offset avoids turning a selected
 * local calendar day into the previous UTC date while satisfying the backend's
 * timezone-aware scheduling contract.
 */
export function reportingDateStartsAt(date: CalendarDate): string {
    const localStart = date.toDate(getLocalTimeZone());
    const offsetMinutes = -localStart.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteMinutes = Math.abs(offsetMinutes);
    const hours = Math.floor(absoluteMinutes / 60).toString().padStart(2, "0");
    const minutes = (absoluteMinutes % 60).toString().padStart(2, "0");
    return `${date.toString()}T00:00:00${sign}${hours}:${minutes}`;
}
