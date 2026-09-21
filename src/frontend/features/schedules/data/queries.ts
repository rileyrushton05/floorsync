"use client";

import { useAuth } from "@/core/auth/AuthProvider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ScheduleSummary } from "./api";
import {
    deleteSchedule,
    fetchScheduleGeneration,
    fetchScheduleTimeline,
    fetchSchedules,
    requestSchedule,
    updateScheduleStatus,
    validateSchedule,
    type ScheduleGenerationStatus,
    type ScheduleStrategy,
} from "./api";
import { jobKeys } from "@/features/jobs/data/keys";
import { scheduleKeys } from "./keys";

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

/** Read the backend's preflight result for exactly the jobs the manager ticked. */
export function useScheduleValidation(jobIds: readonly string[]) {
    const { token } = useAuth();
    const selected = [...jobIds].sort();
    return useQuery({
        queryKey: scheduleKeys.validation(selected),
        enabled: token !== null && selected.length > 0,
        queryFn: ({ signal }) => validateSchedule(selected, requireToken(token), signal),
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
        mutationFn: ({ startsAt, jobIds, strategy }: { startsAt: string; jobIds: string[]; strategy: ScheduleStrategy }) =>
            requestSchedule(startsAt, jobIds, requireToken(token), strategy),
    });
}

/** Move a schedule through the lifecycle the API owns. */
export function useUpdateScheduleStatus() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, status }: { id: string; status: "confirmed" | "discarded" }) =>
            updateScheduleStatus(id, status, requireToken(token)),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
                queryClient.invalidateQueries({ queryKey: jobKeys.all }),
                queryClient.invalidateQueries({ queryKey: jobKeys.definitions }),
            ]);
        },
    });
}

/**
 * Permanently remove a schedule.
 *
 * The API only accepts this for a draft; the caller makes that restriction
 * visible, while a stale screen still receives the API's 409 detail.
 */
export function useDeleteSchedule() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id }: { id: string }) => deleteSchedule(id, requireToken(token)),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
                queryClient.invalidateQueries({ queryKey: jobKeys.all }),
                queryClient.invalidateQueries({ queryKey: jobKeys.definitions }),
            ]);
        },
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
