"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
} from "react";
import { ApiError, type CurrentUser, fetchCurrentUser } from "../_lib/api";
import {
    getServerToken,
    getToken,
    signIn as storeSignIn,
    signOut as storeSignOut,
    subscribe,
} from "../_lib/auth";

/**
 * Who is signed in, for the whole app.
 *
 * The token comes from the external store in `_lib/auth`; the account behind it
 * comes from `GET /auth/me`, which doubles as the check that the token is still
 * valid. A stored token the API rejects is discarded rather than trusted, so a
 * tab left open past the 30-minute expiry lands on the login screen instead of
 * failing one request at a time.
 *
 * `status` is what callers branch on:
 *
 * - `loading`   — a token exists and its account is being fetched.
 * - `anonymous` — no token, or the API refused the one we had.
 * - `signedIn`  — `user` is populated.
 */

export type AuthStatus = "loading" | "anonymous" | "signedIn";

interface AuthValue {
    status: AuthStatus;
    token: string | null;
    user: CurrentUser | null;
    /** Set when the API could not be reached at all, as opposed to refusing us. */
    unreachable: string | null;
    signIn: (username: string, password: string) => Promise<void>;
    signOut: () => void;
}

/** What resolving one specific token produced. */
interface Resolution {
    token: string;
    user: CurrentUser | null;
    unreachable: string | null;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const token = useSyncExternalStore(subscribe, getToken, getServerToken);
    const [resolution, setResolution] = useState<Resolution | null>(null);

    // Resolve the token into an account whenever it changes. The result is keyed
    // by the token it describes, so "no token" and "a token we have not resolved
    // yet" are both derived below rather than assigned from inside the effect —
    // a synchronous setState there cascades renders.
    useEffect(() => {
        if (token === null) return;
        let current = true;
        fetchCurrentUser(token)
            .then((account) => {
                if (current) setResolution({ token, user: account, unreachable: null });
            })
            .catch((error: unknown) => {
                if (!current) return;
                // A refused token is worthless: drop it so the app shows the
                // login screen rather than retrying something invalid. An
                // unreachable API is different — the token may be perfectly
                // good, so it is kept and the outage reported instead.
                if (error instanceof ApiError && error.isUnauthenticated) {
                    storeSignOut();
                    return;
                }
                setResolution({
                    token,
                    user: null,
                    unreachable:
                        error instanceof Error ? error.message : "The API could not be reached.",
                });
            });
        return () => {
            current = false;
        };
    }, [token]);

    const signIn = useCallback(async (username: string, password: string) => {
        // The token change drives the account fetch above; nothing else to do.
        await storeSignIn(username, password);
    }, []);

    const signOut = useCallback(() => {
        storeSignOut();
    }, []);

    const value = useMemo<AuthValue>(() => {
        const settled = resolution?.token === token ? resolution : null;
        const status: AuthStatus =
            token === null ? "anonymous" : settled === null ? "loading" : settled.user !== null ? "signedIn" : "anonymous";

        return {
            status,
            token,
            user: settled?.user ?? null,
            unreachable: settled?.unreachable ?? null,
            signIn,
            signOut,
        };
    }, [token, resolution, signIn, signOut]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
    const value = useContext(AuthContext);
    if (!value) throw new Error("useAuth must be used inside an AuthProvider");
    return value;
}
