"use client";

import { usePathname } from "next/navigation";
import { Tab, TabList, Tabs } from "@/components/ui/tabs";

const TABS = [
    { href: "/manager", label: "Overview" },
    { href: "/manager/jobs", label: "Jobs" },
    { href: "/manager/scheduler", label: "Schedule" },
    { href: "/manager/simulation", label: "Simulation" },
];

/**
 * Section switcher for the manager routes.
 *
 * Built on Intent UI's Tabs rather than a row of links so the group gets the
 * roving-tabindex and arrow-key behaviour React Aria gives a tablist. The tabs
 * navigate by `href`, which the RouterProvider in app/providers.tsx turns into
 * a client-side push.
 */
export function SubNav() {
    const pathname = usePathname();
    const selected = TABS.find((tab) => tab.href === pathname)?.href ?? TABS[0].href;

    return (
        <Tabs selectedKey={selected} aria-label="Manager sections" className="w-auto">
            <TabList items={TABS}>
                {TABS.map((tab) => (
                    <Tab key={tab.href} id={tab.href} href={tab.href}>
                        {tab.label}
                    </Tab>
                ))}
            </TabList>
        </Tabs>
    );
}
