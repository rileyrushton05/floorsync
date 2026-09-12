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

import { signOut } from "./auth";

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

/** A page of a cursor-paginated collection. */
export interface CursorPage<Item> {
    items: Item[];
    next_cursor: string | null;
}

/** A job in the backlog. Its operations are read through `GET /jobs/{id}`. */
export interface Job {
    id: string;
    name: string;
    created_at: string;
    updated_at: string;
}

export type JobPriority = "high" | "med" | "low";

/** One compatible machine route in the job-definition builder contract. */
export interface JobDefinitionRoute {
    machine_id: string;
    duration_minutes: number;
    energy: string | null;
}

/** One ordered operation in a complete job definition. */
export interface JobDefinitionOperation {
    id: string;
    position: number;
    name: string;
    routes: JobDefinitionRoute[];
}

/** The complete, editable job-builder resource. */
export interface JobDefinition {
    id: string;
    name: string;
    priority: JobPriority;
    created_at: string;
    updated_at: string;
    operations: JobDefinitionOperation[];
}

export interface JobDefinitionRouteInput {
    machine_id: string;
    duration_minutes: number;
    energy?: string | null;
}

export interface JobDefinitionOperationInput {
    /** Omit for a new operation; retain it when replacing an existing one. */
    id?: string;
    name: string;
    routes: JobDefinitionRouteInput[];
}

export interface JobDefinitionInput {
    name: string;
    priority: JobPriority;
    operations: JobDefinitionOperationInput[];
}

/**
 * A machine on the floor.
 *
 * `salary` is a decimal on the API and arrives as a **string**: responses are
 * serialised in JSON mode, where a decimal is rendered as text so no precision
 * is lost in transit. Integer columns — a schedule's makespan, an operation's
 * duration — are unaffected and stay numbers.
 */
export interface MachineSummary {
    id: string;
    name: string;
    category_id: string | null;
    salary: string | null;
    active: boolean;
    created_at: string;
    updated_at: string;
}

/** One reason the scheduling engine refused an input, safe to show a person. */
export interface SchedulingIssue {
    code: string;
    message: string;
    operation_id?: string | null;
    machine_id?: string | null;
}

/** The receipt for a queued generation command. The schedule does not exist yet. */
export interface ScheduleGenerationAccepted {
    id: string;
    status: "pending";
    /** `/api/v1/schedules/generations/{id}` — see `fetchScheduleGeneration`. */
    status_url: string;
}

/**
 * How a queued generation command is getting on.
 *
 * `pending` and `running` are transient; the other four are terminal.
 *
 * `pending` is also what an **unknown** generation id reports, because the task
 * queue cannot tell "queued, not started" apart from "never existed" — so a
 * poller needs a ceiling of its own rather than waiting for a state that may
 * never arrive. See `manager/_lib/generation.ts`.
 */
export interface ScheduleGenerationStatus {
    id: string;
    status: "pending" | "running" | "completed" | "rejected" | "unavailable" | "failed";
    /** Set only when `status` is `completed`. */
    schedule_id?: string | null;
    schedule_url?: string | null;
    /** Set only when `status` is `rejected`. */
    issues?: SchedulingIssue[] | null;
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
        // A 401 on an authenticated request means the token is dead — expired
        // or the account disabled — not that this one call went wrong. Drop it
        // here, centrally, so every caller gets signed out rather than each
        // needing its own copy of that decision. The login endpoint itself also
        // answers 401 for bad credentials, but `token` is null for that call so
        // this is a no-op there.
        if (response.status === 401 && token !== null) signOut();
        throw new ApiError(response.status, await problemDetail(response));
    }
    // A successful DELETE intentionally has no JSON body. Keep callers on the
    // same typed wrapper rather than making each one special-case 204.
    if (response.status === 204) return undefined as Body;
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

/**
 * Queue generation of a new draft schedule.
 *
 * Answers 202 the moment the command reaches the queue — nothing has been
 * planned yet and no schedule exists. Poll `fetchScheduleGeneration` with the
 * returned id until it reports a terminal state, then read the schedule it
 * names.
 *
 * The engine plans **every operation in the database**; there is no way to
 * scope a run to a subset of jobs. `startsAt` is the planning origin the engine
 * may schedule from and must be timezone-aware — `new Date().toISOString()` is.
 * It never surfaces in a resolved timeline, whose times are minutes from zero
 * regardless.
 *
 * A broker outage answers 503 as a problem document, so the `ApiError` message
 * is already the sentence to show.
 */
export function requestSchedule(
    startsAt: string,
    token: string,
): Promise<ScheduleGenerationAccepted> {
    return request<ScheduleGenerationAccepted>("/api/v1/schedules", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starts_at: startsAt }),
    });
}

/**
 * Read the state of a queued generation command.
 *
 * The 202 also carries a `status_url` pointing here. It is deliberately not
 * followed: every other call in this module is a typed function over an id, and
 * a path threaded through the caller would be the one exception to that.
 */
export function fetchScheduleGeneration(
    generationId: string,
    token: string,
): Promise<ScheduleGenerationStatus> {
    return request<ScheduleGenerationStatus>(
        `/api/v1/schedules/generations/${encodeURIComponent(generationId)}`,
        token,
    );
}

/**
 * List the job backlog. Requires a manager account.
 *
 * A job is a name and an id; the operations inside it are a separate read, so
 * nothing here reports how much work a job carries. 100 is the largest page the
 * API will serve.
 */
export function fetchJobs(token: string, limit = 100, cursor?: string): Promise<CursorPage<Job>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request<CursorPage<Job>>(`/api/v1/jobs?${query.toString()}`, token);
}

/** Create the persistent part of a job definition currently supported by the API. */
export function createJob(name: string, token: string): Promise<Job> {
    return request<Job>("/api/v1/jobs", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

/** Rename an existing job. Operations and dependencies need a future builder endpoint. */
export function updateJobName(jobId: string, name: string, token: string): Promise<Job> {
    return request<Job>(`/api/v1/jobs/${encodeURIComponent(jobId)}`, token, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

/** Delete a job that has not appeared in a generated schedule. */
export function deleteJob(jobId: string, token: string): Promise<void> {
    return request<void>(`/api/v1/jobs/${encodeURIComponent(jobId)}`, token, {
        method: "DELETE",
    });
}

/** List complete editable definitions, including operations and routes. */
export function fetchJobDefinitions(
    token: string,
    limit = 100,
    cursor?: string,
): Promise<CursorPage<JobDefinition>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request<CursorPage<JobDefinition>>(`/api/v1/job-definitions?${query.toString()}`, token);
}

/** Create a complete job, its operation sequence, and its compatible machine routes. */
export function createJobDefinition(
    definition: JobDefinitionInput,
    token: string,
): Promise<JobDefinition> {
    return request<JobDefinition>("/api/v1/job-definitions", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(definition),
    });
}

/** Atomically replace an editable job definition. */
export function replaceJobDefinition(
    jobId: string,
    definition: JobDefinitionInput,
    token: string,
): Promise<JobDefinition> {
    return request<JobDefinition>(`/api/v1/jobs/${encodeURIComponent(jobId)}/definition`, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(definition),
    });
}

/** List the machines on the floor, active or not. Requires a manager account. */
export function fetchMachines(
    token: string,
    limit = 100,
    cursor?: string,
): Promise<CursorPage<MachineSummary>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request<CursorPage<MachineSummary>>(`/api/v1/machines?${query.toString()}`, token);
}
