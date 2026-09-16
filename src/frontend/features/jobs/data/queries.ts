"use client";

import { useAuth } from "@/core/auth/AuthProvider";
import {
    createJobDefinition,
    deleteJob,
    fetchJobDefinitions,
    fetchJobDependencies,
    fetchJobs,
    replaceJobDefinition,
    replaceJobDependencies,
} from "./api";
import { fetchEveryPage } from "@/core/query/pagination";
import type { JobDef } from "@/domains/scheduling/types";
import { scheduleKeys } from "@/features/schedules/data/keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jobKeys } from "./keys";
import { toJobDefinition, toJobDefinitionInput } from "../model/job-definition";
import { edgesForSavedOperations, type PrecedenceNode } from "../model/dependencies";

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

/** One job's precedence graph. Disabled until a job is actually open. */
export function useJobDependencies(jobId: string | null) {
    const { token } = useAuth();
    return useQuery({
        queryKey: jobKeys.dependencies(jobId ?? "none"),
        enabled: token !== null && jobId !== null,
        queryFn: ({ signal }) => fetchJobDependencies(jobId as string, requireToken(token), signal),
        refetchOnMount: "always",
    });
}

/** What a save needs beyond the definition: the graph the definition cannot carry. */
type JobWithGraph = Omit<JobDef, "id"> & { operations: (JobDef["operations"][number] & PrecedenceNode)[] };

/**
 * Write the job's real precedence over the chain the definition save derived.
 *
 * Saving a definition always rewrites a straight chain from operation order —
 * that is the only shape that endpoint can express. The dependency endpoint
 * replaces every edge pointing into the job, so sending the real graph
 * immediately afterwards is what makes a non-linear job stick. The order is not
 * optional: reversed, the chain would overwrite the graph.
 */
async function writeGraph(saved: JobDef, draft: JobWithGraph, token: string): Promise<void> {
    await replaceJobDependencies(
        saved.id,
        edgesForSavedOperations(draft.operations, saved.operations.map((operation) => operation.id)),
        token,
    );
}

/**
 * Drop the stored graph before re-saving the definition.
 *
 * The definition endpoint derives a chain from the new operation order and then
 * checks the whole graph for cycles — counting the edges already stored, which
 * are this editor's own from the last save. Those are written as `external`, so
 * unlike the chain edges they are not cleared first, and any of them pointing
 * against the new order closes a loop with the derived chain: save a job whose
 * graph does not match its list order and the API refuses it as a cycle, even
 * when the graph being saved is empty.
 *
 * Clearing first means the cycle check only ever sees the chain it just
 * derived. `writeGraph` then puts the real graph back. Cross-job edges *out* of
 * this job survive: the endpoint only clears edges pointing *into* it.
 */
async function saveOverStoredGraph(
    jobId: string,
    token: string,
    save: () => Promise<JobDef>,
): Promise<JobDef> {
    // Read it first: clearing is only safe if it can be put back. A definition
    // save can still be refused afterwards — an inactive machine, a removed
    // operation a schedule recorded — and without this the job would be left
    // stripped of a graph the manager never asked to change.
    const stored = await fetchJobDependencies(jobId, token);
    await replaceJobDependencies(jobId, [], token);
    try {
        return await save();
    } catch (error) {
        await replaceJobDependencies(jobId, stored.edges, token).catch(() => {
            // Swallowed on purpose: the save's own failure is the one worth
            // reporting, and hiding it behind a restore failure would leave the
            // manager with no idea why their save did not go through.
        });
        throw error;
    }
}

export function useCreateJobDefinition() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (job: JobWithGraph) => {
            const authorised = requireToken(token);
            const saved = toJobDefinition(await createJobDefinition(toJobDefinitionInput(job, false), authorised));
            await writeGraph(saved, job, authorised);
            return saved;
        },
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: jobKeys.definitions }),
                queryClient.invalidateQueries({ queryKey: jobKeys.all }),
                queryClient.invalidateQueries({ queryKey: jobKeys.dependenciesAll }),
                queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
            ]);
        },
    });
}

export function useUpdateJobDefinition() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ id, job }: { id: string; job: JobWithGraph }) => {
            const authorised = requireToken(token);
            // Clear, save, rewrite. Only an update needs the clear — a job being
            // created has no stored graph to contradict its own order.
            return await saveOverStoredGraph(id, authorised, async () => {
                const saved = toJobDefinition(
                    await replaceJobDefinition(id, toJobDefinitionInput(job, true), authorised),
                );
                await writeGraph(saved, job, authorised);
                return saved;
            });
        },
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: jobKeys.definitions }),
                queryClient.invalidateQueries({ queryKey: jobKeys.all }),
                queryClient.invalidateQueries({ queryKey: jobKeys.dependenciesAll }),
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
                queryClient.invalidateQueries({ queryKey: jobKeys.dependenciesAll }),
                queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
            ]);
        },
    });
}
