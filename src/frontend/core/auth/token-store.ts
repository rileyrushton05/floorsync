import { type AccessToken, authenticate } from "./api";

/**
 * Where the bearer token lives.
 *
 * A tiny external store rather than React state, for two reasons. It is read by
 * plain functions outside the component tree, and `useSyncExternalStore` lets a
 * component read it without hydrating from an effect — reading `sessionStorage`
 * during render would disagree with the server's HTML, and doing it in an effect
 * means a synchronous `setState` that cascades renders.
 *
 * **`sessionStorage`, deliberately.** The token survives a reload and navigation
 * but dies with the tab, so a testing session is never interrupted and a shared
 * machine keeps nothing afterwards. It is readable by any script on the page,
 * which is true of every browser-held token; the protection that matters is the
 * 30-minute expiry the API puts on it.
 *
 * There is no refresh endpoint, so an expired token cannot be renewed — the API
 * answers 401 and the holder signs in again. `RequireAuth` handles that.
 */

const STORAGE_KEY = "floorsync.token";

const listeners = new Set<() => void>();

/**
 * Read once at module load rather than on every snapshot: `getSnapshot` must be
 * cheap and must return a stable value, and touching storage each call is
 * neither. `sessionStorage` throws in some privacy modes, so a failure is
 * treated as "no token" rather than breaking the page.
 */
function readStored(): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.sessionStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
}

let token: string | null = readStored();

function notify(): void {
    for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The current token. The client snapshot for `useSyncExternalStore`. */
export function getToken(): string | null {
    return token;
}

/**
 * The server snapshot for `useSyncExternalStore`.
 *
 * Always null: the server has no session, so the first paint is always the
 * signed-out one and React re-renders once hydration finds a stored token.
 */
export function getServerToken(): null {
    return null;
}

function setToken(value: string | null): void {
    token = value;
    try {
        if (value === null) window.sessionStorage.removeItem(STORAGE_KEY);
        else window.sessionStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage can be unavailable; the in-memory token still works for this
        // page view, it just will not survive a reload.
    }
    notify();
}

/** Sign in and keep the token. Throws `ApiError` if the credentials are refused. */
export async function signIn(username: string, password: string): Promise<AccessToken> {
    const issued = await authenticate(username, password);
    setToken(issued.access_token);
    return issued;
}

/** Discard the token. Safe to call when there is none. */
export function signOut(): void {
    setToken(null);
}
