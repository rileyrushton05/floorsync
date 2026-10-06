"use client";

import { useAuth } from "@/core/auth/AuthProvider";
import { ApiError } from "@/core/http/client";
import { useQuery } from "@tanstack/react-query";
import { fetchActiveSimulation, fetchOperatorTimeline } from "./api";
import { operatorKeys } from "./keys";

const FALLBACK_POLL_MS = 5_000;

function requireToken(token: string | null): string {
    if (token === null) throw new Error("Sign in again to see your operations.");
    return token;
}

/**
 * The live simulation's durable position, or `null` when none exists yet.
 *
 * `pollMs` is how often to re-read it. The screen polls only while the live
 * socket is down, so a working socket costs no requests and a broken one still
 * keeps the operator's queue fresh.
 */
export function useActiveSimulation(pollMs: number | false) {
    const { token } = useAuth();
    return useQuery({
        queryKey: operatorKeys.activeSimulation,
        enabled: token !== null,
        queryFn: async ({ signal }) => {
            try {
                return await fetchActiveSimulation(requireToken(token), signal);
            } catch (error) {
                if (error instanceof ApiError && error.status === 404) return null;
                throw error;
            }
        },
        refetchInterval: pollMs,
        refetchOnMount: "always",
    });
}

/** A confirmed schedule's timeline never changes, so it is fetched once. */
export function useOperatorTimeline(scheduleId: string | null) {
    const { token } = useAuth();
    return useQuery({
        queryKey: operatorKeys.timeline(scheduleId ?? "none"),
        enabled: token !== null && scheduleId !== null,
        queryFn: ({ signal }) => fetchOperatorTimeline(scheduleId!, requireToken(token), signal),
        staleTime: Infinity,
    });
}

export { FALLBACK_POLL_MS };
