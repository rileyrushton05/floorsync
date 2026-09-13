"use client";

import { usePathname } from "next/navigation";

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

    return (
        <div
            aria-hidden
            className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 animate-[transition-progress-fade_0.5s_ease-out_forwards]"
            key={pathname}
        >
            <div className="h-full w-full overflow-hidden bg-primary/20">
                <div className="h-full w-2/5 animate-[transition-progress_0.5s_ease-in-out_forwards] bg-primary" />
            </div>
        </div>
    );
}
