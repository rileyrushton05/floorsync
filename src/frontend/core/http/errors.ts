/** The concise message safe to show for a failed query or mutation. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "The API could not be reached.";
}
