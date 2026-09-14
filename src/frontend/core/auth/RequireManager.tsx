"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "./AuthProvider";
import { RequireAuth } from "./RequireAuth";

/**
 * Gate a section of the app behind a signed-in *manager* account.
 *
 * Layered on top of `RequireAuth`: once a session exists, an operator account
 * is bounced to their own dashboard instead of being shown manager screens.
 * Some of those screens run entirely on local fixtures, so there is no API
 * call to fall back on for authorization — this guard is what stands between
 * an operator and the manager UI on those routes.
 */
export function RequireManager({ children }: { children: React.ReactNode }) {
    return (
        <RequireAuth>
            <ManagerOnly>{children}</ManagerOnly>
        </RequireAuth>
    );
}

function ManagerOnly({ children }: { children: React.ReactNode }) {
    const { user } = useAuth();
    const router = useRouter();
    const isManager = user?.role === "manager";

    useEffect(() => {
        if (!isManager) router.replace("/operator");
    }, [isManager, router]);

    if (!isManager) {
        return (
            <div className="flex min-h-dvh items-center justify-center bg-bg p-5 text-fg">
                <p className="text-muted-fg text-sm">Redirecting…</p>
            </div>
        );
    }

    return <>{children}</>;
}
