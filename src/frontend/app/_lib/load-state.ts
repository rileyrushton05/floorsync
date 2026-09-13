/**
 * What a screen knows about a value it has to fetch.
 *
 * Every manager page that reads the API has the same four outcomes, so they
 * share one type rather than each declaring its own copy.
 *
 * `forbidden` is deliberately separate from `error`, because it is not a fault.
 * The schedule, job and machine endpoints are all manager-only, so an operator
 * who reaches one of these pages should be told plainly that it is not for them
 * rather than shown a broken screen with a raw 403 in it.
 */
export type LoadState<Value> =
    | { status: "loading" }
    | { status: "ready"; value: Value }
    | { status: "error"; message: string }
    /** Signed in, but this account may not read it. */
    | { status: "forbidden" };

/** The message to show for a thrown value, whether or not it is an `ApiError`. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "The API could not be reached.";
}
