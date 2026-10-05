"use client";

import { Button } from "@/components/ui/button";
import { UserMenu } from "@/core/auth/UserMenu";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Wordmark } from "./Logo";
import { ManagerNavigation } from "./ManagerNavigation";
import { ManagerTopbar } from "./ManagerTopbar";
import { ReportingDateProvider } from "./ReportingDate";

/**
 * Consistent authenticated manager chrome; feature screens provide only their
 * content. A sidebar carries the navigation and the signed-in account; the
 * header above the content carries the section name and the page's actions.
 *
 * From `lg` up the sidebar is pinned beside the content. Below that it slides
 * in over the page from the header's menu button, and closes on Escape, on the
 * backdrop, or when a link changes page (each screen mounts its own shell).
 */
export function ManagerShell({
    actions,
    children,
    reportingDateProvider = true,
    showDatePicker = false,
}: {
    /** Static nodes, or a render function — a function is evaluated inside
        the reporting-date provider, so header actions may call
        `useReportingDate()`. */
    actions?: React.ReactNode | (() => React.ReactNode);
    children: React.ReactNode;
    /** Set false when a page owns the date so its data and topbar share it. */
    reportingDateProvider?: boolean;
    /** Show the reporting-date picker in the header. Only pages that read
        `useReportingDate()` turn it on; elsewhere picking a day would do nothing. */
    showDatePicker?: boolean;
}) {
    const [menuOpen, setMenuOpen] = useState(false);

    useEffect(() => {
        if (!menuOpen) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setMenuOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [menuOpen]);

    const shell = (
        <div className="flex min-h-dvh bg-bg text-fg">
            {menuOpen && (
                <div
                    aria-hidden
                    className="fixed inset-0 z-30 bg-fg/30 lg:hidden"
                    onClick={() => setMenuOpen(false)}
                />
            )}
            <aside
                className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-fg transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0 ${menuOpen ? "translate-x-0" : "-translate-x-full"
                    }`}
            >
                <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-1">
                    <Wordmark />
                    <Button
                        intent="plain"
                        size="sq-sm"
                        aria-label="Close navigation"
                        onPress={() => setMenuOpen(false)}
                        className="lg:hidden"
                    >
                        <XMarkIcon />
                    </Button>
                </div>
                {/* Not clickable — a static label for which dashboard this is. */}
                <span
                    aria-hidden
                    className="px-4 pb-4 font-bold text-[0.68rem] text-muted-fg uppercase tracking-[0.06em] select-none"
                >
                    Manager
                </span>
                <div className="min-h-0 flex-1 overflow-y-auto px-3">
                    <ManagerNavigation />
                </div>
                <div className="border-t border-sidebar-border p-3">
                    <UserMenu />
                </div>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
                <ManagerTopbar onOpenMenu={() => setMenuOpen(true)} showDatePicker={showDatePicker}>
                    {typeof actions === "function" ? actions() : actions}
                </ManagerTopbar>
                {children}
            </div>
        </div>
    );
    return reportingDateProvider ? <ReportingDateProvider>{shell}</ReportingDateProvider> : shell;
}
