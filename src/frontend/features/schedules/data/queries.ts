"use client";

import { useAuth } from "@/core/auth/AuthProvider";
import {
    fetchScheduleGeneration,
    fetchScheduleTimeline,
    fetchSchedules,
    requestSchedule,
    type ScheduleGenerationStatus,
    type ScheduleStrategy,
} from "./api";
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { scheduleKeys } from "./keys";
import type { ScheduleSummary } from "./api";

const GENERATION_POLL_MS = 1_000;

function requireToken(token: string | null): string {
    if (token === null) throw new Error("Sign in again before working with schedules.");
    return token;
}

function isTerminal(status: ScheduleGenerationStatus): boolean {
    return ["completed", "rejected", "unavailable", "failed"].includes(status.status);
}

export function useScheduleSummaries() {
    const { token } = useAuth();
    return useQuery({
        queryKey: scheduleKeys.all,
        enabled: token !== null,
        queryFn: ({ signal }) => fetchSchedules(requireToken(token), signal),
        refetchOnMount: "always",
    });
}

export function useScheduleTimeline(scheduleId: string | null) {
    const { token } = useAuth();
    return useQuery({
        queryKey: scheduleKeys.timeline(scheduleId ?? "none"),
        enabled: token !== null && scheduleId !== null,
        queryFn: ({ signal }) => fetchScheduleTimeline(scheduleId!, requireToken(token), signal),
        refetchOnMount: "always",
    });
}

/** Polls a generation until terminal state without a component-owned loop. */
export function useScheduleGeneration(generation: { id: string; deadline: number } | null) {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    const invalidatedGeneration = useRef<string | null>(null);
    const query = useQuery({
        queryKey: scheduleKeys.generation(generation?.id ?? "none"),
        enabled: token !== null && generation !== null,
        retry: false,
        queryFn: async ({ signal }) => {
            if (generation === null) throw new Error("No schedule generation is selected.");
            if (Date.now() >= generation.deadline) throw new GenerationTimeout(generation.id);
            return fetchScheduleGeneration(generation.id, requireToken(token), signal);
        },
        refetchInterval: (query) => {
            if (generation === null || query.state.error || (query.state.data && isTerminal(query.state.data))) {
                return false;
            }
            return GENERATION_POLL_MS;
        },
    });
    useEffect(() => {
        if (query.data?.status !== "completed" || invalidatedGeneration.current === query.data.id) return;
        invalidatedGeneration.current = query.data.id;
        void queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
    }, [query.data, queryClient]);
    return query;
}

export function useRequestSchedule() {
    const { token } = useAuth();
    return useMutation({
        mutationFn: ({ startsAt, strategy }: { startsAt: string; strategy: ScheduleStrategy }) =>
            requestSchedule(startsAt, requireToken(token), strategy),
    });
}

/**
 * Archive (or restore) a schedule.
 *
 * TODO(backend): wire to the real API once it lands —
 *   archive:   `POST /api/v1/schedules/{id}/archive`
 *   unarchive: `POST /api/v1/schedules/{id}/unarchive`
 * Until then the mutation resolves immediately and optimistically patches the
 * summaries cache, so the UI behaviour is complete and only the HTTP call is
 * missing.
 */
export function useArchiveSchedule() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
            void token; // TODO(backend): `apiRequest(..., requireToken(token), ...)`
            void id;
            void archived;
            return { id, archived };
        },
        onMutate: async ({ id, archived }) => {
            await queryClient.cancelQueries({ queryKey: scheduleKeys.all });
            const previous = queryClient.getQueryData<ScheduleSummary[]>(scheduleKeys.all);
            queryClient.setQueryData<ScheduleSummary[]>(scheduleKeys.all, (current) =>
                (current ?? []).map((schedule) =>
                    schedule.id === id
                        ? // Archiving marks the schedule discarded. Restoring puts back
                          // whatever it was before it was archived — a draft stays a
                          // draft — rather than promoting everything to confirmed.
                          { ...schedule, status: archived ? "discarded" : schedule.status === "discarded" ? "draft" : schedule.status }
                        : schedule,
                ),
            );
            return { previous };
        },
        onError: (_error, _variables, context) => {
            if (context?.previous) queryClient.setQueryData(scheduleKeys.all, context.previous);
        },
        // NOTE: no `onSettled` refetch while the stub resolves locally — a
        // refetch would revert the optimistic patch before the real endpoint
        // exists. Add invalidation here when the TODO above is wired up.
    });
}

export class GenerationTimeout extends Error {
    constructor(readonly generationId: string) {
        super(
            "Polling stopped after three minutes without a terminal schedule status.",
        );
        this.name = "GenerationTimeout";
    }
}
