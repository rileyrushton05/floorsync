import { jobColor, type JobColor } from "../colors";

/**
 * The small round mark that carries a job's colour identity — when it has one.
 *
 * Several of the computed fills sit under 3:1 against the light surface. That
 * is fine on the Gantt, where a block is large and carries its own label, but a
 * bare 12px dot on white is a mark rather than a labelled region and those all
 * but disappear. The inset ring gives every dot a visible edge regardless of
 * its fill, so the mark reads at this size without pulling the palette toward
 * darker colours it does not need to be.
 *
 * Every job has a colour, however many there are — `buildJobColors` computes
 * them rather than drawing from a fixed list — so this always paints.
 */
export function JobDot({
    colors,
    jobId,
    size = "md",
    className = "",
}: {
    colors: Map<string, JobColor>;
    jobId: string;
    size?: "sm" | "md";
    className?: string;
}) {
    const color = jobColor(colors, jobId);
    const box = size === "sm" ? "size-2.5" : "size-3";

    return (
        <span
            aria-hidden
            className={`inline-block shrink-0 rounded-full ring-1 ring-fg/20 ring-inset ${box} ${className}`}
            style={{ background: color.fill }}
        />
    );
}
