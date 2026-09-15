import { jobColor, type JobColor } from "../colors";

/**
 * The small round mark that carries a job's colour identity — when it has one.
 *
 * Three of the eight palette slots (aqua, yellow, magenta) sit under 3:1
 * against the light surface. That is fine on the Gantt, where a block is large
 * and carries its own label, but a bare 12px dot on white is a mark rather than
 * a labelled region and those three all but disappear. The inset ring gives
 * every dot a visible edge regardless of its fill, so the mark reads at this
 * size without changing the validated palette.
 *
 * Past the eighth job there is no colour to show. It renders as empty space of
 * the same size rather than a grey disc: a grey shared by every remaining job
 * looks like an assignment and invites a reading that is not there, whereas
 * nothing is honest and keeps the names beside it aligned.
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

    if (color === null) {
        return <span aria-hidden className={`inline-block shrink-0 ${box} ${className}`} />;
    }

    return (
        <span
            aria-hidden
            className={`inline-block shrink-0 rounded-full ring-1 ring-fg/20 ring-inset ${box} ${className}`}
            style={{ background: color.fill }}
        />
    );
}
