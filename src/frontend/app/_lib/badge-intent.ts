import type { BadgeProps } from "@/components/ui/badge";

/**
 * Maps FloorSync's domain vocabulary onto Intent UI's badge intents.
 *
 * The old bespoke Badge carried its own `tone` scale (red/amber/blue/green/
 * gray). Intent UI already ships those semantics as `danger`/`warning`/`info`/
 * `success`/`secondary`, so the tone scale is gone and only the domain
 * knowledge — what counts as urgent, what counts as done — lives here.
 */
export type BadgeIntent = NonNullable<BadgeProps["intent"]>;

export function priorityIntent(priority: string): BadgeIntent {
    const p = priority.toLowerCase();
    if (p === "high") return "danger";
    if (p === "medium" || p === "med") return "warning";
    if (p === "normal" || p === "norm") return "info";
    return "success";
}

export function statusIntent(status: string): BadgeIntent {
    const s = status.toLowerCase();
    if (s.includes("delay")) return "danger";
    if (s.includes("wait") || s.includes("warn")) return "warning";
    if (s.includes("run") || s.includes("active") || s.includes("progress")) return "info";
    if (s.includes("complet") || s.includes("done")) return "success";
    return "secondary";
}
