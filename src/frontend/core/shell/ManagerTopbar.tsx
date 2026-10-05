"use client";

import { Button } from "@/components/ui/button";
import { Bars3Icon } from "@heroicons/react/24/outline";
import { usePathname } from "next/navigation";
import { sectionLabel } from "./ManagerNavigation";
import { ReportingDatePicker } from "./ReportingDatePicker";

/**
 * The header above every manager page's content: the current section's name,
 * the reporting-date picker, and that page's own actions. Navigation lives in
 * the sidebar; below `lg`, where the sidebar is tucked away, the menu button
 * here opens it.
 */
export function ManagerTopbar({
    onOpenMenu,
    children,
}: {
    onOpenMenu: () => void;
    children?: React.ReactNode;
}) {
    const pathname = usePathname();

    return (
        <header className="flex min-h-15 flex-nowrap items-center gap-4 border-b bg-navbar px-5 py-2.5 whitespace-nowrap">
            <Button intent="plain" size="sq-sm" aria-label="Open navigation" onPress={onOpenMenu} className="lg:hidden">
                <Bars3Icon />
            </Button>
            <h1 className="m-0 font-bold text-lg tracking-tight">{sectionLabel(pathname)}</h1>
            <ReportingDatePicker />
            <div className="ml-auto flex items-center gap-2.5">{children}</div>
        </header>
    );
}
