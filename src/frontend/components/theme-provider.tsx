"use client";

import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";

/**
 * Intent UI components (notably <Toast />) read the active theme through
 * `useTheme`, so the app has to provide one.
 *
 * The system preference is deliberately *not* followed: FloorSync's operations
 * surfaces are designed light, and the navy palette is scoped to the landing
 * page via `.theme-navy` rather than to an OS setting. Dark mode still works if
 * something calls `setTheme("dark")` — `.dark` is defined in app/styles.css.
 */
export function ThemeProvider({
    children,
    ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
    return (
        <NextThemesProvider
            attribute="class"
            defaultTheme="light"
            enableSystem={false}
            disableTransitionOnChange
            {...props}
        >
            {children}
        </NextThemesProvider>
    );
}

export { useTheme };
