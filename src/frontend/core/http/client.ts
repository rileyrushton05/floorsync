/**
 * The only browser transport used by the frontend.
 *
 * Endpoint functions stay with the feature that owns their contracts; this
 * module only standardises base URL, headers and failures.  In particular, an
 * abort is deliberately rethrown so TanStack Query can cancel stale work
 * without turning navigation into a retryable network error.
 */

import type { InvalidParameter, ProblemDetail } from "./contracts";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8002";

const apiFallbackMessage = (status: number, statusText: string) =>
    `The API answered ${status} ${statusText}.`;

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly problem: ProblemDetail | null,
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

    /** Backend-provided field reasons, preserved without client-side rewriting. */
    get invalidParameters(): readonly InvalidParameter[] {
        return this.problem?.invalid_params ?? [];
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
        throw new ApiError(0, null, `Could not reach the API at ${BASE_URL}.`);
    }

    if (!response.ok) {
        if (response.status === 401 && token !== null) onUnauthenticated?.();
        const problem = await problemDetail(response);
        throw new ApiError(
            response.status,
            problem,
            problem?.detail ?? problem?.title ?? apiFallbackMessage(response.status, response.statusText),
        );
    }
    if (response.status === 204) return undefined as Body;
    return (await response.json()) as Body;
}

async function problemDetail(response: Response): Promise<ProblemDetail | null> {
    try {
        const body: unknown = await response.json();
        if (body === null || typeof body !== "object") return null;

        const value = body as Record<string, unknown>;
        const invalidParams = Array.isArray(value.invalid_params)
            ? value.invalid_params.flatMap((parameter): InvalidParameter[] => {
                if (parameter === null || typeof parameter !== "object") return [];
                const { name, reason } = parameter as Record<string, unknown>;
                return typeof name === "string" && typeof reason === "string" ? [{ name, reason }] : [];
            })
            : null;
        return {
            type: typeof value.type === "string" ? value.type : "about:blank",
            title: typeof value.title === "string" ? value.title : apiFallbackMessage(response.status, response.statusText),
            status: typeof value.status === "number" ? value.status : response.status,
            detail: typeof value.detail === "string" ? value.detail : null,
            instance: typeof value.instance === "string" ? value.instance : null,
            invalid_params: invalidParams,
        };
    } catch {
        // A proxy failure need not be JSON.
    }
    return null;
}
