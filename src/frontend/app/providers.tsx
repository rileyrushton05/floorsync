"use client";

import { ThemeProvider } from "@/components/theme-provider";
import { TransitionProgress } from "@/components/transition-progress";
import { Toast } from "@/components/ui/toast";
import { useRouter } from "next/navigation";
import { RouterProvider } from "react-aria-components";
import { AuthProvider } from "./_components/AuthProvider";

/**
 * App-wide client providers.
 *
 * `RouterProvider` is what lets every Intent UI component that takes an `href`
 * — Link, Tab, MenuItem, GridListItem — navigate through the Next router
 * instead of doing a full page load. Without it those components fall back to
 * plain anchors and the app reloads on every internal navigation.
 *
 * `AuthProvider` sits inside it, so signing in and out can navigate, and wraps
 * everything else because the login page needs the same auth state the guarded
 * routes do.
 */
export function Providers({ children }: { children: React.ReactNode }) {
    const router = useRouter();

    return (
        <ThemeProvider>
            <TransitionProgress />
            <RouterProvider navigate={(href) => router.push(href)}>
                <AuthProvider>
                    {children}
                    <Toast position="top-right" />
                </AuthProvider>
            </RouterProvider>
        </ThemeProvider>
    );
}
