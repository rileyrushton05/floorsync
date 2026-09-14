/**
 * The only browser transport used by the frontend.
 *
 * Endpoint functions stay with the feature that owns their contracts; this
 * module only standardises base URL, headers and failures.  In particular, an
 * abort is deliberately rethrown so TanStack Query can cancel stale work
 * without turning navigation into a retryable network error.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8002";

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "ApiError";
    }

    get isUnauthenticated(): boolean {
        return this.status === 401;
    }

    get isForbidden(): boolean {
        return this.status === 403;
    }
}

let onUnauthenticated: (() => void) | null = null;

/** Register the session cleanup policy without coupling transport to auth. */
export function setUnauthenticatedHandler(handler: (() => void) | null): () => void {
    onUnauthenticated = handler;
    return () => {
        if (onUnauthenticated === handler) onUnauthenticated = null;
    };
}

export async function apiRequest<Body>(
    path: string,
    token: string | null,
    init?: RequestInit,
): Promise<Body> {
    let response: Response;
    try {
        response = await fetch(`${BASE_URL}${path}`, {
            ...init,
            headers: {
                Accept: "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...init?.headers,
            },
        });
    } catch (error) {
        // Query cancellation is control flow, not an offline failure. `signal`
        // is checked too because runtimes do not all use the same AbortError.
        if (init?.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
            throw error;
        }
        throw new ApiError(0, `Could not reach the API at ${BASE_URL}.`);
    }

    if (!response.ok) {
        if (response.status === 401 && token !== null) onUnauthenticated?.();
        throw new ApiError(response.status, await problemDetail(response));
    }
    if (response.status === 204) return undefined as Body;
    return (await response.json()) as Body;
}

async function problemDetail(response: Response): Promise<string> {
    try {
        const body: unknown = await response.json();
        if (body !== null && typeof body === "object" && "detail" in body) {
            const { detail } = body as { detail: unknown };
            if (typeof detail === "string") return detail;
        }
    } catch {
        // A proxy failure need not be JSON.
    }
    return `The API answered ${response.status} ${response.statusText}.`;
}
