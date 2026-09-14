import { ApiError } from "./client";

/** The concise message safe to show for a failed query or mutation. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "The API could not be reached.";
}

/** Exact field reasons supplied by the API, for optional field-level display. */
export function invalidParameterMessages(error: unknown): readonly string[] {
    if (!(error instanceof ApiError)) return [];
    return error.invalidParameters.map(({ name, reason }) => `${name}: ${reason}`);
}
