"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { type Appearance, DEFAULT_THEME, THEME_COOKIE, type ThemeId, themeOption } from "./themes";

/**
 * The active theme, and the way to change it.
 *
 * This used to wrap `next-themes`, but its provider renders an inline <script>
 * that React 19 refuses to execute on the client, so it is a small context
 * instead. The choice lives in a cookie rather than localStorage: the root
 * layout reads it and puts `data-theme` on <html> in the server render, so the
 * page arrives in the right palette with no script and no flash of light.
 *
 * "system" needs no JavaScript either — app/styles.css switches it with a
 * `prefers-color-scheme` media query.
 *
 * Intent UI components (notably <Toast />) read `appearance` to pick their
 * light or dark styling.
 */

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const ThemeContext = createContext<{
    theme: ThemeId;
    appearance: Appearance;
    setTheme: (theme: ThemeId) => void;
}>({
    theme: DEFAULT_THEME,
    appearance: "light",
    setTheme: () => {},
});

export function ThemeProvider({ initialTheme, children }: React.PropsWithChildren<{ initialTheme: ThemeId }>) {
    const [theme, setThemeState] = useState<ThemeId>(initialTheme);

    const setTheme = useCallback((next: ThemeId) => {
        setThemeState(next);
        document.documentElement.dataset.theme = next;
        document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
    }, []);

    const value = useMemo(
        () => ({ theme, appearance: themeOption(theme).appearance, setTheme }),
        [theme, setTheme],
    );
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
    return useContext(ThemeContext);
}
