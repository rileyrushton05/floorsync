/**
 * The browser's view of the FloorSync API.
 *
 * One base URL from `NEXT_PUBLIC_API_URL`, one fetch wrapper, and a typed
 * function per endpoint. The API answers failures as RFC 9457 problem details,
 * so `detail` is the field a person should be shown — the status line is only a
 * fallback for when the body is not a problem document.
 *
 * Failures throw `ApiError`, which carries the status code as well as the
 * message. Callers need the code to tell "your session has expired" (401) from
 * "your account may not do that" (403) from everything else, and those three
 * want different responses rather than one generic error.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8002";

/** A failed API call, carrying the status so callers can branch on it. */
export class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }

    /** The token is missing, expired or rejected. Signing in again is the fix. */
    get isUnauthenticated(): boolean {
        return this.status === 401;
    }

    /** Authenticated, but this account is not allowed to do it. */
    get isForbidden(): boolean {
        return this.status === 403;
    }
}

/** A lane in a resolved timeline: a machine row or a job. */
export interface TimelineLane {
    key: string;
    label: string;
}

/** One scheduled operation, already placed on the clock by the backend. */
export interface TimelineOperation {
    key: string;
    job_key: string;
    machine_key: string;
    label: string;
    start: number;
    end: number;
    machine_slot: number;
}

/**
 * A stored schedule resolved onto the clock.
 *
 * Immutable for a confirmed schedule — the same entries and dependencies always
 * resolve to the same times — so fetch it once and animate locally rather than
 * polling. Times are in the schedule's own units, which the database documents
 * as minutes.
 */
export interface ScheduleTimeline {
    schedule_id: string;
    makespan: number;
    machines: TimelineLane[];
    jobs: TimelineLane[];
    operations: TimelineOperation[];
}

/** One schedule without its entries, enough to choose between them. */
export interface ScheduleSummary {
    id: string;
    status: "draft" | "confirmed" | "discarded";
    strategy: string;
    makespan: number | null;
    input_operation_count: number | null;
    created_at: string;
    confirmed_at: string | null;
}

export interface AccessToken {
    access_token: string;
    token_type: string;
    expires_in: number;
}

/** The safe subset of the signed-in account the API exposes. */
export interface CurrentUser {
    id: string;
    name: string;
    role: "manager" | "operator";
    machine_id: string | null;
}

async function request<Body>(path: string, token: string | null, init?: RequestInit): Promise<Body> {
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
    } catch {
        // A network-level failure has no status; 0 is the conventional stand-in
        // and keeps every caller on one error type.
        throw new ApiError(0, `Could not reach the API at ${BASE_URL}.`);
    }

    if (!response.ok) {
        throw new ApiError(response.status, await problemDetail(response));
    }
    return (await response.json()) as Body;
}

/** Prefer the API's own explanation of a failure over the bare status line. */
async function problemDetail(response: Response): Promise<string> {
    try {
        const body: unknown = await response.json();
        if (body !== null && typeof body === "object" && "detail" in body) {
            const { detail } = body as { detail: unknown };
            if (typeof detail === "string") return detail;
        }
    } catch {
        // A gateway or proxy failure need not answer in JSON at all.
    }
    return `The API answered ${response.status} ${response.statusText}.`;
}

/**
 * Exchange a username and password for a bearer token.
 *
 * The endpoint is OAuth2 password flow, so the body is form-encoded rather than
 * JSON — sending JSON here gets a 422 about missing form fields.
 */
export function authenticate(username: string, password: string): Promise<AccessToken> {
    return request<AccessToken>("/api/v1/auth/token", null, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username, password }).toString(),
    });
}

/** Read the account a token belongs to. Also the cheapest way to test one. */
export function fetchCurrentUser(token: string): Promise<CurrentUser> {
    return request<CurrentUser>("/api/v1/auth/me", token);
}

/** List every schedule, newest first. Requires a manager account. */
export function fetchSchedules(token: string): Promise<ScheduleSummary[]> {
    return request<ScheduleSummary[]>("/api/v1/schedules", token);
}

/** Fetch one schedule resolved onto the clock. */
export function fetchScheduleTimeline(
    scheduleId: string,
    token: string,
): Promise<ScheduleTimeline> {
    return request<ScheduleTimeline>(
        `/api/v1/schedules/${encodeURIComponent(scheduleId)}/timeline`,
        token,
    );
}
