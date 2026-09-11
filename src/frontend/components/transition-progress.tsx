"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Indeterminate top loading bar shown during client-side route transitions.
 *
 * Next.js streams the new route quickly in this app, so instead of hooking
 * router internals the bar animates in whenever the pathname changes and
 * fades out once the render settles. This gives every page change a visible
 * "something is happening" cue even when the swap is nearly instant.
 */
export function TransitionProgress() {
    const pathname = usePathname();
    const [active, setActive] = useState(false);

    useEffect(() => {
        setActive(true);
        const done = setTimeout(() => setActive(false), 500);
        return () => clearTimeout(done);
    }, [pathname]);

    return (
        <div
            aria-hidden
            className={`pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 transition-opacity duration-300 ${active ? "opacity-100" : "opacity-0"
                }`}
        >
            {active && (
                <div className="h-full w-full overflow-hidden bg-primary/20">
                    <div className="h-full w-2/5 animate-[transition-progress_0.5s_ease-in-out_forwards] bg-primary" />
                </div>
            )}
        </div>
    );
}
