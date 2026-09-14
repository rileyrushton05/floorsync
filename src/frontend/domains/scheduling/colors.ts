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

/**
 * Colour is keyed to the job's position in the backlog, not to its position in
 * the current selection — so filtering the schedule down to fewer jobs never
 * repaints the ones that remain.
 *
 * Only an id is needed, so this accepts the API's `Job` as readily as the local
 * `JobDef`. That is what lets the scheduler colour its backlog list and the
 * chart it draws from a single map, keyed off the backlog either way.
 */
export function buildJobColors(jobs: readonly { id: string }[]): Map<string, JobColor> {
    return new Map(jobs.map((job, index) => [job.id, PALETTE[index] ?? OVERFLOW]));
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
