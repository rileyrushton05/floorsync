/**
 * Categorical palette for job identity on the Gantt.
 *
 * Fixed order, never cycled. Validated for the light chart surface (#f8fafc):
 * all eight clear the lightness band, chroma floor, adjacent-pair CVD
 * separation and the normal-vision floor. Three slots (aqua, yellow, magenta)
 * sit under 3:1 against the surface, so the relief rule applies — every block
 * carries a visible job-id label and the chart ships a legend, so colour is
 * always a reinforcing channel rather than the only way to tell jobs apart.
 *
 * `ink` is whichever of near-black / white has the better contrast on that
 * fill; the worst pairing is 3.98:1.
 *
 * Re-validated against the app's own light surface (`--muted`, #f8fafc) rather
 * than a generic one: lightness band, chroma floor, adjacent-pair CVD
 * separation (worst ΔE 9.1) and the normal-vision floor (worst ΔE 19.6) all
 * pass, with the three known sub-3:1 slots carrying the relief rule above. It
 * stays a single light column on purpose — `components/theme-provider.tsx`
 * pins the theme to "light" and the navy palette is scoped to the landing
 * page, so a second column would be unreachable code rather than dark support.
 */
export interface JobColor {
    fill: string;
    ink: string;
}

const PALETTE: JobColor[] = [
    { fill: "#2a78d6", ink: "#0b0b0b" }, // blue
    { fill: "#eb6834", ink: "#0b0b0b" }, // orange
    { fill: "#1baf7a", ink: "#0b0b0b" }, // aqua
    { fill: "#eda100", ink: "#0b0b0b" }, // yellow
    { fill: "#e87ba4", ink: "#0b0b0b" }, // magenta
    { fill: "#008300", ink: "#ffffff" }, // green
    { fill: "#4a3aa7", ink: "#ffffff" }, // violet
    { fill: "#e34948", ink: "#0b0b0b" }, // red
];

/** Past the eight slots, colour stops carrying identity and the label alone does. */
const OVERFLOW: JobColor = { fill: "#64748b", ink: "#ffffff" };

/** What `stableJobOrder` and `buildJobColors` need off a job: an id, ideally a creation time. */
export interface ColourableJob {
    id: string;
    createdAt?: string;
    created_at?: string;
}

function createdAtOf(job: ColourableJob): string {
    return job.createdAt ?? job.created_at ?? "";
}

/**
 * Jobs in the order colour slots and backlog sequence numbers are handed out.
 *
 * Colour has to follow the *job*, never its rank in the current list. The API
 * returns jobs ordered by `(name, id)`, so using array position would repaint
 * the entire backlog the moment one job is renamed — a rename is not a change
 * of identity, and the schedule someone is reading should not change colour
 * underneath them. Creation time is the ordering the job actually owns, with
 * the id as tie-breaker so the result is a total order.
 *
 * Sources without a creation time (the schedule timeline contract) keep the
 * order they arrived in, which for a timeline is the backend's own lane order.
 */
export function stableJobOrder<T extends ColourableJob>(jobs: readonly T[]): T[] {
    if (!jobs.some((job) => createdAtOf(job) !== "")) return [...jobs];
    return [...jobs].sort((left, right) => {
        const byCreation = createdAtOf(left).localeCompare(createdAtOf(right));
        return byCreation !== 0 ? byCreation : left.id.localeCompare(right.id);
    });
}

/**
 * Assign each job its colour slot, keyed off `stableJobOrder` rather than the
 * order the caller happens to hold — so filtering the schedule down to fewer
 * jobs, re-sorting the backlog, or renaming a job never repaints the rest.
 *
 * Only an id is needed, so this accepts the API's `Job` as readily as the local
 * `JobDef`. That is what lets the scheduler colour its backlog list and the
 * chart it draws from a single map, keyed off the backlog either way.
 */
export function buildJobColors(jobs: readonly ColourableJob[]): Map<string, JobColor> {
    return new Map(stableJobOrder(jobs).map((job, index) => [job.id, PALETTE[index] ?? OVERFLOW]));
}

export function jobColor(colors: Map<string, JobColor>, jobId: string): JobColor {
    return colors.get(jobId) ?? OVERFLOW;
}

/** Blend a hex toward white. `weight` is how much of the original survives. */
export function tint(hex: string, weight: number): string {
    const value = parseInt(hex.slice(1), 16);
    const mix = (channel: number) => Math.round(channel * weight + 255 * (1 - weight));
    const r = mix((value >> 16) & 0xff);
    const g = mix((value >> 8) & 0xff);
    const b = mix(value & 0xff);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
