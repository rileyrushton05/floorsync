"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "./AuthProvider";
import { RequireAuth } from "./RequireAuth";

/**
 * Gate a section of the app behind a signed-in *operator* account.
 *
 * The mirror of `RequireManager`: once a session exists, a manager account is
 * bounced to the manager dashboard instead of being shown an operator queue. A
 * manager has no machine, so the operator screen has nothing to show them.
 */
export function RequireOperator({ children }: { children: React.ReactNode }) {
    return (
        <RequireAuth>
            <OperatorOnly>{children}</OperatorOnly>
        </RequireAuth>
    );
}

function OperatorOnly({ children }: { children: React.ReactNode }) {
    const { user } = useAuth();
    const router = useRouter();
    const isOperator = user?.role === "operator";

    useEffect(() => {
        if (!isOperator) router.replace("/manager");
    }, [isOperator, router]);

    if (!isOperator) {
        return (
            <div className="flex min-h-dvh items-center justify-center bg-bg p-5 text-fg">
                <p className="text-muted-fg text-sm">Redirecting…</p>
            </div>
        );
    }

    return <>{children}</>;
}
