import { jobColor, type JobColor } from "../colors";

/**
 * The small round mark that carries a job's colour identity.
 *
 * Three of the eight palette slots (aqua, yellow, magenta) sit under 3:1
 * against the light surface. That is fine on the Gantt, where a block is large
 * and carries its own label, but a bare 12px dot on white is a mark rather than
 * a labelled region and those three all but disappear. The inset ring gives
 * every dot a visible edge regardless of its fill, so the mark reads at this
 * size without changing the validated palette.
 *
 * `currentColor` is deliberate: the ring is the surface showing through, so the
 * dot keeps its edge on a white card, a muted panel and a selected row alike.
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
    return (
        <span
            aria-hidden
            className={`inline-block shrink-0 rounded-full ring-1 ring-fg/20 ring-inset ${size === "sm" ? "size-2.5" : "size-3"
                } ${className}`}
            style={{ background: jobColor(colors, jobId).fill }}
        />
    );
}
