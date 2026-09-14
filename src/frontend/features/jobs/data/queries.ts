"use client";

import { useAuth } from "@/core/auth/AuthProvider";
import {
    createJobDefinition,
    deleteJob,
    fetchJobDefinitions,
    fetchJobs,
    replaceJobDefinition,
} from "./api";
import { fetchEveryPage } from "@/core/query/pagination";
import type { JobDef } from "@/domains/scheduling/types";
import { scheduleKeys } from "@/features/schedules/data/keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jobKeys } from "./keys";
import { toJobDefinition, toJobDefinitionInput } from "../model/job-definition";

function requireToken(token: string | null): string {
    if (token === null) throw new Error("Sign in again before changing the job backlog.");
    return token;
}

export function useJobDefinitions() {
    const { token } = useAuth();
    return useQuery({
        queryKey: jobKeys.definitions,
        enabled: token !== null,
        queryFn: async ({ signal }) =>
            (await fetchEveryPage(
                (cursor, pageSignal) => fetchJobDefinitions(requireToken(token), 100, cursor, pageSignal),
                signal,
            )).map(toJobDefinition),
        refetchOnMount: "always",
    });
}

/** Lightweight backlog records for screens that do not need editable routes. */
export function useJobSummaries() {
    const { token } = useAuth();
    return useQuery({
        queryKey: jobKeys.all,
        enabled: token !== null,
        queryFn: ({ signal }) =>
            fetchEveryPage((cursor, pageSignal) => fetchJobs(requireToken(token), 100, cursor, pageSignal), signal),
        refetchOnMount: "always",
    });
}

export function useCreateJobDefinition() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (job: Omit<JobDef, "id">) =>
            createJobDefinition(toJobDefinitionInput(job, false), requireToken(token)).then(toJobDefinition),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: jobKeys.definitions }),
                queryClient.invalidateQueries({ queryKey: jobKeys.all }),
                queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
            ]);
        },
    });
}

export function useUpdateJobDefinition() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, job }: { id: string; job: Omit<JobDef, "id"> }) =>
            replaceJobDefinition(id, toJobDefinitionInput(job, true), requireToken(token)).then(toJobDefinition),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: jobKeys.definitions }),
                queryClient.invalidateQueries({ queryKey: jobKeys.all }),
                queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
            ]);
        },
    });
}

export function useDeleteJobDefinition() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => deleteJob(id, requireToken(token)),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: jobKeys.definitions }),
                queryClient.invalidateQueries({ queryKey: jobKeys.all }),
                queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
            ]);
        },
    });
}
