"use client";

import { Link } from "@/components/ui/link";
import {
    ArchiveBoxIcon,
    ChartBarSquareIcon,
    ChevronDownIcon,
    ClipboardDocumentListIcon,
    CpuChipIcon,
    PlayCircleIcon,
    Squares2X2Icon,
} from "@heroicons/react/24/outline";
import { usePathname } from "next/navigation";
import { Button, Disclosure, DisclosurePanel, Heading } from "react-aria-components/Disclosure";

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };
type NavGroup = { label: string; items: NavItem[] };

const NAV: (NavItem | NavGroup)[] = [
    { href: "/manager", label: "Overview", icon: Squares2X2Icon },
    {
        label: "Resources",
        items: [
            { href: "/manager/jobs", label: "Jobs", icon: ClipboardDocumentListIcon },
            { href: "/manager/machines", label: "Machines", icon: CpuChipIcon },
        ],
    },
    {
        label: "Scheduling",
        items: [
            { href: "/manager/schedules", label: "Schedules", icon: ArchiveBoxIcon },
            { href: "/manager/planner", label: "Planner", icon: ChartBarSquareIcon },
            { href: "/manager/simulation", label: "Simulation", icon: PlayCircleIcon },
        ],
    },
];

const ITEMS = NAV.flatMap((entry) => ("items" in entry ? entry.items : [entry]));

/** The label of the manager section `pathname` belongs to, for the page header. */
export function sectionLabel(pathname: string): string {
    return ITEMS.find((item) => item.href === pathname)?.label ?? ITEMS[0].label;
}

/**
 * Section switcher for the manager routes, laid out down the sidebar.
 *
 * Related sections sit in collapsible groups (React Aria's Disclosure, so the
 * toggle carries `aria-expanded` and keyboard support). Every group starts
 * open, so no section is ever hidden by default. The links navigate through
 * the RouterProvider in app/providers.tsx, so the navigation guard still sees
 * them.
 */
export function ManagerNavigation() {
    const pathname = usePathname();

    const link = (item: NavItem) => {
        const current = pathname === item.href;
        const Icon = item.icon;
        return (
            <Link
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm no-underline hover:no-underline ${current
                    ? "bg-sidebar-primary font-semibold text-sidebar-primary-fg"
                    : "text-sidebar-fg/80 hover:bg-sidebar-accent hover:text-sidebar-accent-fg"
                    }`}
            >
                <Icon className="size-5 shrink-0" />
                {item.label}
            </Link>
        );
    };

    return (
        <nav aria-label="Manager sections" className="flex flex-col gap-1">
            {NAV.map((entry) =>
                "items" in entry ? (
                    <Disclosure key={entry.label} defaultExpanded className="mt-3">
                        {({ isExpanded }) => (
                            <>
                                <Heading className="m-0">
                                    <Button
                                        slot="trigger"
                                        className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 font-bold text-[0.68rem] text-muted-fg uppercase tracking-[0.06em] outline-hidden hover:text-sidebar-fg focus-visible:outline-2 focus-visible:outline-sidebar-ring"
                                    >
                                        {entry.label}
                                        <ChevronDownIcon
                                            className={`size-3.5 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
                                        />
                                    </Button>
                                </Heading>
                                <DisclosurePanel>
                                    <div className="flex flex-col gap-1 pt-1">{entry.items.map(link)}</div>
                                </DisclosurePanel>
                            </>
                        )}
                    </Disclosure>
                ) : (
                    link(entry)
                ),
            )}
        </nav>
    );
}
