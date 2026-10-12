/**
 * The themes a person can pick in Settings.
 *
 * Kept out of theme-provider.tsx because the root layout (a server component)
 * reads this list to validate the theme cookie, and a value imported from a
 * "use client" module arrives on the server as a client reference rather than
 * as the value itself.
 *
 * Each id matches a `[data-theme="…"]` palette in app/styles.css.
 */

export type Appearance = "light" | "dark" | "system";

export interface ThemeOption {
    id: string;
    label: string;
    description: string;
    /** Which way the palette leans, so sonner and native controls can follow. */
    appearance: Appearance;
    fun?: boolean;
}

export const THEMES = [
    { id: "light", label: "Light", description: "The standard FloorSync surface.", appearance: "light" },
    { id: "dark", label: "Dark", description: "Easier on the eyes after dark.", appearance: "dark" },
    { id: "system", label: "System", description: "Follows your device's setting.", appearance: "system" },
    { id: "navy", label: "Deep Sea", description: "The landing page's navy, everywhere.", appearance: "dark", fun: true },
    { id: "synthwave", label: "Synthwave", description: "Neon pink on midnight purple.", appearance: "dark", fun: true },
    { id: "terminal", label: "Terminal", description: "Green phosphor, square corners, monospace.", appearance: "dark", fun: true },
    { id: "forest", label: "Forest", description: "Mossy greens and warm bark.", appearance: "light", fun: true },
    { id: "bubblegum", label: "Bubblegum", description: "Pink, round and unapologetic.", appearance: "light", fun: true },
] as const satisfies readonly ThemeOption[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "light";

/** Cookie the choice is stored in, so the server can render the right palette first time. */
export const THEME_COOKIE = "floorsync-theme";

export function isThemeId(value: unknown): value is ThemeId {
    return THEMES.some((theme) => theme.id === value);
}

export function themeOption(id: ThemeId): ThemeOption {
    return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}
