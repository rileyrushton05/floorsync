"use client";

import { useRouter } from "next/navigation";
import { RouterProvider } from "react-aria-components";
import { ThemeProvider } from "@/components/theme-provider";
import { Toast } from "@/components/ui/toast";
import { TransitionProgress } from "@/components/transition-progress";

/**
 * App-wide client providers.
 *
 * `RouterProvider` is what lets every Intent UI component that takes an `href`
 * — Link, Tab, MenuItem, GridListItem — navigate through the Next router
 * instead of doing a full page load. Without it those components fall back to
 * plain anchors and the app reloads on every internal navigation.
 */
export function Providers({ children }: { children: React.ReactNode }) {
    const router = useRouter();

    return (
        <ThemeProvider>
            <TransitionProgress />
            <RouterProvider navigate={(href) => router.push(href)}>
                {children}
                <Toast position="top-right" />
            </RouterProvider>
        </ThemeProvider>
    );
}
