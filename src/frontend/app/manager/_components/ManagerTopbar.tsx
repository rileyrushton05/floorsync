"use client";

import { Wordmark } from "../../_components/Logo";
import { UserMenu } from "../../_components/UserMenu";
import { SubNav } from "./SubNav";

/**
 * Shared topbar chrome for every manager route.
 *
 * The "Manager" label is a plain, non-interactive heading: it is spaced away
 * from the wordmark and carries no hover affordance, so it never reads as a
 * link the way the section tabs next to it do.
 */
export function ManagerTopbar({ children }: { children?: React.ReactNode }) {
    return (
        <header className="flex flex-nowrap items-center gap-5 border-b bg-navbar px-7 py-3.5">
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
            <SubNav />
            <div className="flex-1" />
            {children}
            <UserMenu />
        </header>
    );
}
