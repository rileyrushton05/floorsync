"use client";

import { useAuth } from "@/app/_components/AuthProvider";
import {
    fetchScheduleGeneration,
    fetchScheduleTimeline,
    fetchSchedules,
    requestSchedule,
    type ScheduleGenerationStatus,
    type ScheduleStrategy,
} from "@/app/_lib/api";
import { queryKeys } from "@/app/_lib/query-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
        queryKey: queryKeys.schedules.all,
        enabled: token !== null,
        queryFn: ({ signal }) => fetchSchedules(requireToken(token), signal),
        refetchOnMount: "always",
    });
}

export function useScheduleTimeline(scheduleId: string | null) {
    const { token } = useAuth();
    return useQuery({
        queryKey: queryKeys.schedules.timeline(scheduleId ?? "none"),
        enabled: token !== null && scheduleId !== null,
        queryFn: ({ signal }) => fetchScheduleTimeline(scheduleId!, requireToken(token), signal),
        refetchOnMount: "always",
    });
}

/** Polls a generation until terminal state without a component-owned loop. */
export function useScheduleGeneration(generation: { id: string; deadline: number } | null) {
    const { token } = useAuth();
    return useQuery({
        queryKey: queryKeys.schedules.generation(generation?.id ?? "none"),
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
}

export function useRequestSchedule() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ startsAt, strategy }: { startsAt: string; strategy: ScheduleStrategy }) =>
            requestSchedule(startsAt, requireToken(token), strategy),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all });
        },
    });
}

export class GenerationTimeout extends Error {
    constructor(readonly generationId: string) {
        super(
            "The API accepted the request, but nothing reported picking it up within three minutes. Check that the scheduling worker is running.",
        );
        this.name = "GenerationTimeout";
    }
}
