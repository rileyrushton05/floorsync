"use client";

import { ThemeProvider } from "@/components/theme-provider";
import { TransitionProgress } from "@/components/transition-progress";
import { Toast } from "@/components/ui/toast";
import { AuthProvider } from "@/core/auth/AuthProvider";
import { NavigationGuardProvider } from "@/core/navigation/NavigationGuard";
import { ClearQueryCacheOnAuthChange, QueryProvider } from "@/core/query/QueryProvider";

/**
 * App-wide client providers.
 *
 * `NavigationGuardProvider` owns the `RouterProvider` that lets every Intent UI
 * component taking an `href` — Link, Tab, MenuItem, GridListItem — navigate
 * through the Next router instead of doing a full page load. Without it those
 * components fall back to plain anchors and the app reloads on every internal
 * navigation. It wraps that one `navigate` so a screen holding unsaved work can
 * hold the navigation and ask first.
 *
 * `AuthProvider` sits inside it, so signing in and out can navigate, and wraps
 * everything else because the login page needs the same auth state the guarded
 * routes do.
 */
export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider>
            <TransitionProgress />
            <NavigationGuardProvider>
                <QueryProvider>
                    <AuthProvider>
                        <ClearQueryCacheOnAuthChange />
                        {children}
                        <Toast position="top-right" />
                    </AuthProvider>
                </QueryProvider>
            </NavigationGuardProvider>
        </ThemeProvider>
    );
}
