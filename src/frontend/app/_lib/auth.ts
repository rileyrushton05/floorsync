import { type AccessToken, authenticate } from "./api";

/**
 * Development-only sign-in.
 *
 * Every schedule route requires a bearer token and this app has no sign-in
 * screen yet, so the credentials below come from the environment and the token
 * is fetched silently on first use.
 *
 * **These credentials are compiled into the client bundle.** Anything prefixed
 * `NEXT_PUBLIC_` is inlined at build time and readable by anyone who opens the
 * page, so this arrangement is for a local database with seeded data and nothing
 * else. It is a placeholder for a real sign-in route, not a shortcut around one —
 * replace it before this is deployed anywhere, and never point it at an account
 * that matters.
 *
 * The token is cached in module scope for the tab's lifetime. It is not written
 * to `localStorage`: persisting a shared development credential outlives the
 * problem it solves, and a reload re-fetching it costs one request.
 */

const USERNAME = process.env.NEXT_PUBLIC_DEV_USERNAME ?? "";
const PASSWORD = process.env.NEXT_PUBLIC_DEV_PASSWORD ?? "";

export class MissingCredentialsError extends Error {
    constructor() {
        super(
            "No development credentials are set. Add NEXT_PUBLIC_DEV_USERNAME and " +
                "NEXT_PUBLIC_DEV_PASSWORD to src/frontend/.env.local and restart the dev server.",
        );
        this.name = "MissingCredentialsError";
    }
}

let cached: Promise<AccessToken> | null = null;

/**
 * Return a bearer token, signing in on first call.
 *
 * Concurrent callers share one in-flight request rather than racing to sign in
 * several times. A failure clears the cache so the next attempt retries instead
 * of replaying the rejection forever.
 */
export function accessToken(): Promise<string> {
    if (!USERNAME || !PASSWORD) return Promise.reject(new MissingCredentialsError());

    cached ??= authenticate(USERNAME, PASSWORD);
    return cached
        .then((token) => token.access_token)
        .catch((error: unknown) => {
            cached = null;
            throw error;
        });
}

/** Discard the cached token, so the next call signs in again. */
export function forgetToken(): void {
    cached = null;
}
