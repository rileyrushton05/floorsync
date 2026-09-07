/**
 * The browser's view of the FloorSync API.
 *
 * One base URL from `NEXT_PUBLIC_API_URL`, one fetch wrapper, and a typed
 * function per endpoint. The API answers failures as RFC 9457 problem details,
 * so `detail` is the field a person should be shown — the status line is only a
 * fallback for when the body is not a problem document.
 *
 * **Every schedule route needs a bearer token**, and the app has no sign-in
 * screen, so `authenticate()` trades development credentials for one through the
 * ordinary `POST /auth/token` route. See `auth.ts` for why that is a local-only
 * arrangement.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8002";

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

async function request<Body>(path: string, token: string | null, init?: RequestInit): Promise<Body> {
    const response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
            Accept: "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...init?.headers,
        },
    });

    if (!response.ok) {
        throw new Error(await problemDetail(response));
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

/** List every schedule, newest first. */
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
