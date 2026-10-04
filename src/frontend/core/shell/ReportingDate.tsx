"use client";

import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { getLocalTimeZone, today, type CalendarDate } from "@internationalized/date";

interface ReportingDateContextValue {
    date: CalendarDate;
    setDate: (date: CalendarDate) => void;
}

const ReportingDateContext = createContext<ReportingDateContextValue | null>(null);

/**
 * The reporting date every manager page shares. It starts at today in the
 * manager's timezone; the overview reads it to slice its fixture weeks, and
 * any screen that wants to react to the day calls `useReportingDate()`.
 */
export function ReportingDateProvider({ children }: { children: ReactNode }) {
    const [date, setDate] = useState<CalendarDate>(() => today(getLocalTimeZone()));
    const value = useMemo(() => ({ date, setDate }), [date]);
    return <ReportingDateContext value={value}>{children}</ReportingDateContext>;
}

export function useReportingDate(): ReportingDateContextValue {
    const context = use(ReportingDateContext);
    if (context === null) throw new Error("useReportingDate must be used within ReportingDateProvider");
    return context;
}
