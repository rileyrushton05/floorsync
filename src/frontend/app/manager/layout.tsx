"use client";

import { RequireAuth } from "../_components/RequireAuth";
import { PlanningProvider } from "./_components/PlanningProvider";

/**
 * Provides planning state to every /manager route, behind a signed-in account.
 * It deliberately renders no chrome of its own — each page owns its topbar and
 * places <SubNav /> inside it.
 */
export default function ManagerLayout({ children }: { children: React.ReactNode }) {
    return (
        <RequireAuth>
            <PlanningProvider>{children}</PlanningProvider>
        </RequireAuth>
    );
}
