"use client";

import { PlanningProvider } from "./_components/PlanningProvider";

/**
 * Provides planning state to every /manager route. It deliberately renders no
 * chrome of its own — each page owns its topbar and places <SubNav /> inside it.
 */
export default function ManagerLayout({ children }: { children: React.ReactNode }) {
    return <PlanningProvider>{children}</PlanningProvider>;
}
