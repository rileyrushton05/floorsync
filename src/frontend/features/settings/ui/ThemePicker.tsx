"use client";

import { THEMES, type ThemeId, type ThemeOption } from "@/components/themes";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { Radio, RadioGroup } from "react-aria-components/RadioGroup";

/**
 * A grid of theme cards, each with a miniature of the app drawn in that theme.
 *
 * Built on React Aria's RadioGroup, so it is one tab stop with arrow keys
 * moving between themes, and choosing one applies it immediately — there is
 * nothing to save.
 *
 * The miniatures need no colours of their own: each sets `data-theme` on its
 * own element, and app/styles.css scopes every palette to that attribute.
 */
export function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (theme: ThemeId) => void }) {
    const standard = THEMES.filter((theme) => !("fun" in theme));
    const fun = THEMES.filter((theme) => "fun" in theme);

    return (
        <RadioGroup
            aria-label="Theme"
            value={value}
            onChange={(next) => onChange(next as ThemeId)}
            className="flex flex-col gap-6"
        >
            <ThemeGrid heading="Standard" themes={standard} />
            <ThemeGrid heading="Just for fun" themes={fun} />
        </RadioGroup>
    );
}

function ThemeGrid({ heading, themes }: { heading: string; themes: readonly ThemeOption[] }) {
    return (
        <div className="flex flex-col gap-2.5">
            <h3 className="m-0 font-bold text-[0.68rem] text-muted-fg uppercase tracking-[0.06em]">{heading}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {themes.map((theme) => (
                    <ThemeCard key={theme.id} theme={theme} />
                ))}
            </div>
        </div>
    );
}

function ThemeCard({ theme }: { theme: ThemeOption }) {
    return (
        <Radio
            value={theme.id}
            className={({ isSelected, isFocusVisible }) =>
                `group relative flex cursor-pointer flex-col gap-3 rounded-lg border bg-overlay p-3 text-overlay-fg shadow-xs outline-hidden transition hover:border-primary/60 ${isSelected ? "border-primary ring-2 ring-primary/30" : ""
                } ${isFocusVisible ? "outline-2 outline-offset-2 outline-ring" : ""}`
            }
        >
            {({ isSelected }) => (
                <>
                    {theme.id === "system" ? <SplitPreview /> : <Preview themeId={theme.id} />}
                    <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1">
                            <span className="block font-semibold text-sm">{theme.label}</span>
                            <span className="block text-muted-fg text-xs">{theme.description}</span>
                        </span>
                        <CheckCircleIcon
                            aria-hidden
                            className={`size-5 shrink-0 text-primary transition-opacity ${isSelected ? "opacity-100" : "opacity-0"}`}
                        />
                    </div>
                </>
            )}
        </Radio>
    );
}

/** Bar heights for the miniature's chart, as percentages. */
const BARS = [
    { height: "45%", className: "bg-primary" },
    { height: "75%", className: "bg-success" },
    { height: "55%", className: "bg-warning" },
    { height: "90%", className: "bg-danger" },
];

/** A tiny sidebar, header, chart and button, drawn in `themeId`'s palette. */
function Preview({ themeId, className = "" }: { themeId: string; className?: string }) {
    return (
        <div
            aria-hidden
            data-theme={themeId}
            className={`flex h-24 overflow-hidden rounded-md border bg-bg font-sans text-fg ${className}`}
        >
            <div className="flex w-1/4 flex-col gap-1.5 border-e border-sidebar-border bg-sidebar p-2">
                <span className="h-1.5 w-3/4 rounded-full bg-fg/70" />
                <span className="mt-1 h-2.5 rounded-sm bg-sidebar-primary" />
                <span className="h-1.5 w-4/5 rounded-full bg-muted-fg/40" />
                <span className="h-1.5 w-3/5 rounded-full bg-muted-fg/40" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-4 items-center border-b bg-navbar px-2">
                    <span className="h-1.5 w-1/3 rounded-full bg-fg/60" />
                </div>
                <div className="flex flex-1 gap-2 p-2">
                    <div className="flex flex-1 items-end gap-1 rounded-sm border bg-overlay p-1.5">
                        {BARS.map((bar) => (
                            <span
                                key={bar.className}
                                className={`flex-1 rounded-t-sm ${bar.className}`}
                                style={{ height: bar.height }}
                            />
                        ))}
                    </div>
                    <div className="flex w-1/4 flex-col justify-end gap-1">
                        <span className="h-1.5 rounded-full bg-muted-fg/40" />
                        <span className="h-3 rounded-sm bg-primary" />
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Light and dark split on the diagonal, for "follow the device". */
function SplitPreview() {
    return (
        <div aria-hidden className="relative">
            <Preview themeId="light" />
            <Preview themeId="dark" className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]" />
        </div>
    );
}
