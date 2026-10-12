"use client";

import { RequireAuth } from "@/core/auth/RequireAuth";

/**
 * Guards the settings page. Any signed-in account may use it, so this is
 * `RequireAuth` rather than `RequireManager`.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth>{children}</RequireAuth>;
}
