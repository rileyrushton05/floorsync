"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "./AuthProvider";

/**
 * Gate a section of the app behind a signed-in account.
 *
 * Anyone anonymous is sent to `/login` carrying where they were headed, so
 * signing in returns them there rather than dumping them on a landing page.
 * This is a client-side guard over a client-side app: it decides what to render,
 * not what the API will serve. Every protected route is protected because the
 * API demands a bearer token, and this only saves a person from watching each
 * request fail one at a time.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
    const { status, unreachable } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (status !== "anonymous" || unreachable !== null) return;
        // `replace`, not `push`: a bounced-off page should not sit in history
        // waiting for the back button to bounce them again.
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }, [status, unreachable, router, pathname]);

    if (status === "signedIn") return <>{children}</>;

    return (
        <div className="flex min-h-dvh items-center justify-center bg-bg p-5 text-fg">
            <div className="max-w-prose rounded-lg border border-dashed bg-overlay p-8 text-center">
                {unreachable === null ? (
                    <p className="text-muted-fg text-sm">
                        {status === "loading" ? "Checking your session…" : "Redirecting to sign in…"}
                    </p>
                ) : (
                    <>
                        <h2 className="font-semibold text-lg">The API is unreachable</h2>
                        <p className="mt-2 text-muted-fg text-sm">{unreachable}</p>
                        <p className="mt-2 text-muted-fg text-sm">
                            Your session has not been signed out — this is a connection problem, not
                            a credentials one. Start the API and reload.
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}
