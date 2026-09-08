"use client";

import { RequireManager } from "../_components/RequireManager";
import { PlanningProvider } from "./_components/PlanningProvider";

/**
 * Provides planning state to every /manager route, behind a signed-in manager
 * account. It deliberately renders no chrome of its own — each page owns its
 * topbar and places <SubNav /> inside it.
 */
export default function ManagerLayout({ children }: { children: React.ReactNode }) {
    return (
        <RequireManager>
            <PlanningProvider>{children}</PlanningProvider>
        </RequireManager>
    );
}
