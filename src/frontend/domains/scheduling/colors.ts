/**
 * Job identity colour, computed rather than picked from a fixed list.
 *
 * This used to be eight hand-tuned hues. Eight is not enough — a floor with
 * more jobs than that had the rest sharing one grey, so the colour told you
 * nothing about exactly the jobs you had just added. Instead each job's colour
 * is derived from its position in the backlog's stable order, from a sequence
 * that never runs out.
 *
 * **The hue step is 147.5°, and that number is doing real work.** The obvious
 * scheme — space N hues evenly around the wheel — is the wrong one: it puts
 * consecutive jobs adjacent in hue, so at thirteen jobs neighbours land 27.7°
 * apart and become indistinguishable (measured ΔE 5.4 for *normal* vision,
 * far below the 15 floor, before colour blindness enters into it). Stepping by
 * 147.5° instead throws each successive job to the far side of the wheel, so
 * the jobs most likely to be compared are the ones furthest apart in colour.
 * Lightness alternates as a second axis, which is what carries the pairs hue
 * alone cannot separate.
 *
 * Validated with the dataviz skill's checker against this app's own light
 * surface (`--muted`, #f8fafc) for every job count from 2 to 24: lightness
 * band, chroma floor, adjacent-pair CVD separation and the normal-vision floor
 * all pass. At thirteen jobs the worst adjacent pair is ΔE 9.6 for protanopia
 * and 27.8 for normal vision. **Past 24 the CVD gate starts to fail** — there
 * is no ordering of that many distinguishable hues — so beyond that colour
 * quietly degrades into a supporting channel. That is acceptable only because
 * it always is one: every Gantt block carries its job name, the chart ships a
 * legend, and the backlog lists a name and number, so nothing is ever
 * identified by colour alone.
 *
 * Several fills sit under 3:1 against the surface, which is the documented
 * relief case and is covered by those same visible labels. `ink` is whichever
 * of near-black / white reads better on a given fill; across 24 jobs the worst
 * pairing is 4.36:1, up from the 3.98:1 of the fixed palette this replaced.
 *
 * Note the colour depends on the job's *index*, never on how many jobs exist,
 * so adding a job does not repaint the others. A single light surface is
 * deliberate: `components/theme-provider.tsx` pins the theme to "light".
 */
export interface JobColor {
    fill: string;
    ink: string;
}

/** Where the sequence starts — close to the blue this palette has always opened on. */
const ANCHOR_HUE = 255;
/** See the note above: consecutive jobs land on opposite sides of the wheel. */
const HUE_STEP = 147.5;
const CHROMA = 0.15;
const BASE_LIGHTNESS = 0.6;
/** Lightness alternates so hue is not the only thing separating two jobs. */
const LIGHTNESS_SHIFT = [-0.02, 0.12];

/** OKLCH -> linear sRGB (Björn Ottosson's matrices). */
function oklchToLinearRgb(lightness: number, chroma: number, hue: number): [number, number, number] {
    const radians = (hue * Math.PI) / 180;
    const a = chroma * Math.cos(radians);
    const b = chroma * Math.sin(radians);
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
}

const isDisplayable = (rgb: readonly number[]) => rgb.every((channel) => channel >= -0.0001 && channel <= 1.0001);

function encodeChannel(channel: number): number {
    const clamped = Math.min(1, Math.max(0, channel));
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
}

/**
 * OKLCH to a hex sRGB colour, reducing chroma until the colour actually fits in
 * the display gamut. Clamping the channels instead would silently shift the hue
 * — two jobs whose requested colours differ only past the gamut boundary would
 * come back the same colour.
 */
function oklchToHex(lightness: number, chroma: number, hue: number): string {
    let displayable = 0;
    let tooSaturated = chroma;
    if (isDisplayable(oklchToLinearRgb(lightness, chroma, hue))) {
        displayable = chroma;
    } else {
        for (let step = 0; step < 24; step += 1) {
            const midpoint = (displayable + tooSaturated) / 2;
            if (isDisplayable(oklchToLinearRgb(lightness, midpoint, hue))) displayable = midpoint;
            else tooSaturated = midpoint;
        }
    }
    const [red, green, blue] = oklchToLinearRgb(lightness, displayable, hue).map(encodeChannel);
    return `#${((red << 16) | (green << 8) | blue).toString(16).padStart(6, "0")}`;
}

/** WCAG relative luminance, for choosing readable ink on a fill. */
function relativeLuminance(hex: string): number {
    const value = parseInt(hex.slice(1), 16);
    const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((channel) => {
        const unit = channel / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Whichever of near-black / white reads better on this fill. */
function inkFor(fill: string): string {
    const luminance = relativeLuminance(fill);
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#0b0b0b" : "#ffffff";
}

/** The colour for the job sitting at `index` of the stable backlog order. */
export function jobColorAt(index: number): JobColor {
    const hue = (ANCHOR_HUE + index * HUE_STEP) % 360;
    const lightness = BASE_LIGHTNESS + LIGHTNESS_SHIFT[index % LIGHTNESS_SHIFT.length];
    const fill = oklchToHex(lightness, CHROMA, hue);
    return { fill, ink: inkFor(fill) };
}

/** Only for an id that is not in the map at all — an unknown job, not a designed state. */
export const NEUTRAL_JOB_COLOR: JobColor = { fill: "#64748b", ink: "#ffffff" };

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
 * Give every job a colour, keyed off `stableJobOrder` rather than the order the
 * caller happens to hold — so filtering the schedule down to fewer jobs,
 * re-sorting the backlog, or renaming a job never repaints the rest. No job is
 * ever left without one, however many there are.
 *
 * Only an id is needed, so this accepts the API's `Job` as readily as the local
 * `JobDef`. That is what lets the scheduler colour its backlog list and the
 * chart it draws from a single map, keyed off the backlog either way.
 */
export function buildJobColors(jobs: readonly ColourableJob[]): Map<string, JobColor> {
    return new Map(stableJobOrder(jobs).map((job, index) => [job.id, jobColorAt(index)]));
}

/** The job's colour. The fallback is only reached for an id that was never in the list. */
export function jobColor(colors: Map<string, JobColor>, jobId: string): JobColor {
    return colors.get(jobId) ?? NEUTRAL_JOB_COLOR;
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
