import { fetchScheduleGeneration, type ScheduleGenerationStatus } from "@/app/_lib/api";

/**
 * Wait for a queued schedule generation to finish.
 *
 * `POST /api/v1/schedules` answers 202 and hands back a generation id; the run
 * itself happens on a worker. There is no push channel, so the only way to
 * learn the outcome is to ask repeatedly.
 *
 * **The ceiling is not padding — it is what ends the loop.** The task queue
 * reports `pending` for a command it has never heard of, exactly as it does for
 * one that is queued and waiting. So a stopped worker, a lost command and a
 * genuinely slow run are indistinguishable from here, and none of them will
 * ever produce a terminal state on their own. Without a deadline this polls
 * until the tab closes.
 *
 * Every call is abortable, because a manager who presses Generate twice, or
 * navigates away mid-run, must not leave a loop writing into a screen that is
 * no longer there.
 */

const TERMINAL_STATUSES: ReadonlySet<ScheduleGenerationStatus["status"]> = new Set([
    "completed",
    "rejected",
    "unavailable",
    "failed",
] as const);

/** One second: a generation takes seconds, and the status read is a cache hit. */
const POLL_INTERVAL_MS = 1_000;

/** Three minutes. Long enough for a real run, short enough to report a stall. */
const POLL_CEILING_MS = 180_000;

/**
 * The run never reported an outcome. Carries the generation id, which is the
 * only handle anyone has on it afterwards.
 */
export class GenerationTimeout extends Error {
    readonly generationId: string;

    constructor(generationId: string) {
        super(
            "The API accepted the request, but nothing reported picking it up within three " +
                "minutes. Check that the scheduling worker is running.",
        );
        this.name = "GenerationTimeout";
        this.generationId = generationId;
    }
}

/** Whether a reported state is one the run can still move on from. */
export function isTerminal(status: ScheduleGenerationStatus): boolean {
    return TERMINAL_STATUSES.has(status.status);
}

function abortError(): DOMException {
    return new DOMException("Aborted", "AbortError");
}

/**
 * `setTimeout` that rejects rather than firing if the wait is abandoned.
 *
 * The already-aborted case has to be handled first: `abort` is an event, and a
 * listener attached after it has fired is never called — so waiting for one on
 * a spent signal would hang for the full interval and then resolve as if
 * nothing had happened.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

export interface AwaitGenerationOptions {
    signal: AbortSignal;
    /** Called with every reading, terminal or not, so a caller can show progress. */
    onProgress?: (status: ScheduleGenerationStatus) => void;
}

/**
 * Poll a generation command until it reaches a terminal state.
 *
 * Resolves with that state — including `rejected`, `unavailable` and `failed`,
 * which are outcomes of a run that worked rather than failures of this call.
 * Throws `GenerationTimeout` if the ceiling is reached, an `ApiError` if a
 * status read itself fails, and an `AbortError` if the caller gave up.
 */
export async function awaitGeneration(
    generationId: string,
    token: string,
    { signal, onProgress }: AwaitGenerationOptions,
): Promise<ScheduleGenerationStatus> {
    const deadline = Date.now() + POLL_CEILING_MS;

    for (;;) {
        if (signal.aborted) throw abortError();

        const status = await fetchScheduleGeneration(generationId, token);
        onProgress?.(status);
        if (isTerminal(status)) return status;

        // Checked before sleeping rather than after, so the ceiling is a bound
        // on how long this waits rather than on how long it waited.
        if (Date.now() + POLL_INTERVAL_MS >= deadline) throw new GenerationTimeout(generationId);
        await sleep(POLL_INTERVAL_MS, signal);
    }
}
