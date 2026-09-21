import { ManagerTopbar } from "./ManagerTopbar";
import { ReportingDateProvider } from "./ReportingDate";

/** Consistent authenticated manager chrome; feature screens provide only their content. */
export function ManagerShell({
    actions,
    children,
    reportingDateProvider = true,
}: {
    /** Static nodes, or a render function — a function is evaluated inside
        the reporting-date provider, so topbar actions may call
        `useReportingDate()` (they render below `ManagerTopbar`). */
    actions?: React.ReactNode | (() => React.ReactNode);
    children: React.ReactNode;
    /** Set false when a page owns the date so its data and topbar share it. */
    reportingDateProvider?: boolean;
}) {
    const shell = (
        <div className="flex min-h-dvh flex-col bg-bg text-fg">
            <ManagerTopbar>{typeof actions === "function" ? actions() : actions}</ManagerTopbar>
            {children}
        </div>
    );
    return reportingDateProvider ? <ReportingDateProvider>{shell}</ReportingDateProvider> : shell;
}
