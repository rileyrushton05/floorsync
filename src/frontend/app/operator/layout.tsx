"use client";

import { RequireAuth } from "@/core/auth/RequireAuth";

/**
 * Guards the operator dashboard.
 *
 * The queue is read from the API with the session's token, so the page cannot be
 * shown anonymously; the API still decides what an account may read.
 */
export default function OperatorLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth>{children}</RequireAuth>;
}
