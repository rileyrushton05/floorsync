"use client";

import { RequireAuth } from "../_components/RequireAuth";

/**
 * Guards the operator dashboard.
 *
 * The page still runs on its own fixtures and calls no API, so the token buys it
 * nothing yet. It is wrapped anyway: an operator's queue is not public, and the
 * guard should already be here when the page starts reading it from the API.
 */
export default function OperatorLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth>{children}</RequireAuth>;
}
