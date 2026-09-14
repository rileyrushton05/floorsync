"use client";

import { RequireManager } from "../_components/RequireManager";

/**
 * Guards every /manager route behind a signed-in manager account. Each screen
 * owns its own API resources through feature query hooks and owns its chrome.
 */
export default function ManagerLayout({ children }: { children: React.ReactNode }) {
    return <RequireManager>{children}</RequireManager>;
}
