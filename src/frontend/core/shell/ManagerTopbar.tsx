"use client";

import { UserMenu } from "@/core/auth/UserMenu";
import { Wordmark } from "./Logo";
import { ManagerNavigation } from "./ManagerNavigation";
import { ReportingDatePicker } from "./ReportingDatePicker";

/**
 * Shared topbar chrome for every manager route.
 *
 * The "Manager" label is a plain, non-interactive heading: it is spaced away
 * from the wordmark and carries no hover affordance, so it never reads as a
 * link the way the section tabs next to it do.
 */
export function ManagerTopbar({ children }: { children?: React.ReactNode }) {
    return (
        <header className="flex flex-nowrap items-center gap-5 border-b bg-navbar px-7 py-3.5 whitespace-nowrap">
            <div className="flex items-center gap-5 flex-shrink-0">
                <Wordmark />
                {/* Not clickable — a static section label, deliberately given a
                    gap from the wordmark and no hover/cursor affordance. */}
                <span
                    aria-hidden
                    className="border-s border-border pl-4 font-bold text-muted-fg text-xs uppercase tracking-[0.06em] select-none"
                >
                    Manager
                </span>
            </div>
            <ManagerNavigation />
            {/* The reporting-date calendar sits dead-centre of the bar on every
                manager page, between the section tabs and the page actions. */}
            <div className="flex min-w-fit flex-1 items-center justify-center">
                <ReportingDatePicker />
            </div>
            {children}
            <UserMenu />
        </header>
    );
}
