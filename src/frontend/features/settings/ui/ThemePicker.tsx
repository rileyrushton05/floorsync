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

/** Gantt rows for the miniature: offset and width as percentages of the lane. */
const LANES = [
    [{ left: 0, width: 38, color: "bg-chart-1" }, { left: 44, width: 30, color: "bg-chart-2" }],
    [{ left: 12, width: 26, color: "bg-chart-3" }, { left: 52, width: 40, color: "bg-chart-1" }],
    [{ left: 4, width: 46, color: "bg-chart-4" }, { left: 58, width: 22, color: "bg-chart-5" }],
];

/**
 * A miniature manager screen — sidebar, header with an action, a schedule
 * panel and status badges — drawn in `themeId`'s palette.
 */
function Preview({ themeId, className = "" }: { themeId: string; className?: string }) {
    return (
        <div
            aria-hidden
            data-theme={themeId}
            className={`flex h-28 overflow-hidden rounded-md border bg-bg font-sans text-fg ${className}`}
        >
            <div className="flex w-1/4 flex-col gap-1 border-e border-sidebar-border bg-sidebar p-1.5 text-sidebar-fg">
                <span className="mb-1 flex items-center gap-1">
                    <span className="size-2 rounded-full bg-primary" />
                    <span className="font-bold text-[0.4rem]">FloorSync</span>
                </span>
                <span className="rounded-sm bg-sidebar-primary px-1 py-0.5 font-semibold text-[0.35rem] text-sidebar-primary-fg">
                    Overview
                </span>
                <span className="px-1 text-[0.35rem] opacity-70">Jobs</span>
                <span className="px-1 text-[0.35rem] opacity-70">Machines</span>
                <span className="px-1 text-[0.35rem] opacity-70">Planner</span>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-5 shrink-0 items-center justify-between border-b bg-navbar px-1.5 text-navbar-fg">
                    <span className="font-bold text-[0.45rem]">Overview</span>
                    <span className="rounded-sm bg-primary px-1 py-0.5 font-medium text-[0.35rem] text-primary-fg">
                        Generate
                    </span>
                </div>
                <div className="flex flex-1 flex-col gap-1 p-1.5">
                    <div className="flex gap-1">
                        <span className="rounded-sm bg-success-subtle px-1 text-[0.35rem] text-success-subtle-fg">On time</span>
                        <span className="rounded-sm bg-warning-subtle px-1 text-[0.35rem] text-warning-subtle-fg">2 late</span>
                        <span className="rounded-sm bg-danger-subtle px-1 text-[0.35rem] text-danger-subtle-fg">1 down</span>
                    </div>
                    <div className="flex flex-1 flex-col justify-around rounded-sm border bg-overlay px-1">
                        {LANES.map((lane, row) => (
                            <div key={row} className="relative h-1.5 rounded-full bg-muted">
                                {lane.map((block) => (
                                    <span
                                        key={block.left}
                                        className={`absolute inset-y-0 rounded-[1px] ${block.color}`}
                                        style={{ left: `${block.left}%`, width: `${block.width}%` }}
                                    />
                                ))}
                            </div>
                        ))}
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
