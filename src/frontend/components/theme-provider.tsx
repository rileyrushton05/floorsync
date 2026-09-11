"use client";

import { createContext, useContext, useMemo } from "react";

/**
 * Intent UI components (notably <Toast />) read the active theme through
 * `useTheme`, so the app has to provide one.
 *
 * This used to wrap `next-themes`, but its provider renders an inline <script>
 * that React 19 refuses to execute on the client, so it's now a minimal
 * context with the same shape. The theme is always "light": FloorSync's
 * operations surfaces are designed light, and the navy palette is scoped to
 * the landing page via `.theme-navy` rather than to an OS setting. (`.dark`
 * is still defined in app/styles.css if dark mode is ever needed.)
 */

type Theme = "light" | "dark" | "system";

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({
    theme: "light",
    setTheme: () => {},
});

export function ThemeProvider({ children }: React.PropsWithChildren) {
    const value = useMemo(() => ({ theme: "light" as Theme, setTheme: () => {} }), []);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
    return useContext(ThemeContext);
}
