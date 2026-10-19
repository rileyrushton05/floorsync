"use client";

import { RequireOperator } from "@/core/auth/RequireOperator";

/**
 * Guards the operator dashboard behind a signed-in operator account; a manager
 * is sent to their own dashboard instead.
 *
 * The queue is read from the API with the session's token, so the page cannot be
 * shown anonymously; the API still decides what an account may read.
 */
export default function OperatorLayout({ children }: { children: React.ReactNode }) {
    return <RequireOperator>{children}</RequireOperator>;
}
