import { toast } from "sonner";
import { errorMessage, invalidParameterMessages } from "@/core/http/errors";

/**
 * Report a user-initiated write failure without replacing the API's message.
 *
 * Query failures stay in their owning page state because they can happen on a
 * background refresh. Mutations have an explicit user action, so the API's
 * `detail` belongs in a toast. Validation reasons are also backend-provided;
 * exposing them in the description keeps the otherwise generic 422 detail
 * actionable without creating a second validation vocabulary in the browser.
 */
export function reportMutationError(error: unknown): void {
    reportBackendFailure(errorMessage(error), invalidParameterMessages(error));
}

/** Report a safe message already supplied by an asynchronous API resource. */
export function reportBackendFailure(message: string, details: readonly string[] = []): void {
    toast.error(message, {
        ...(details.length > 0 ? { description: details.join("\n") } : {}),
    });
}
