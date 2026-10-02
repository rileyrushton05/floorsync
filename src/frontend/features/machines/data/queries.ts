"use client";

import { useAuth } from "@/core/auth/AuthProvider";
import { fetchEveryPage } from "@/core/query/pagination";
import {
    createMachine,
    deleteMachine,
    fetchMachineCategories,
    fetchMachines,
    updateMachine,
    type MachineInput,
} from "./api";
import { jobKeys } from "@/features/jobs/data/keys";
import { scheduleKeys } from "@/features/schedules/data/keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { machineKeys } from "./keys";

type SaveMachineInput =
    | { id: null; values: MachineInput }
    | { id: string; values: Partial<MachineInput> };

function requireToken(token: string | null): string {
    if (token === null) throw new Error("Sign in again before changing machines.");
    return token;
}

export function useMachines() {
    const { token } = useAuth();
    return useQuery({
        queryKey: machineKeys.all,
        enabled: token !== null,
        queryFn: ({ signal }) =>
            fetchEveryPage((cursor, pageSignal) => fetchMachines(requireToken(token), 100, cursor, pageSignal), signal),
        refetchOnMount: "always",
    });
}

export function useMachineCategories() {
    const { token } = useAuth();
    return useQuery({
        queryKey: machineKeys.categories,
        enabled: token !== null,
        queryFn: ({ signal }) => fetchMachineCategories(requireToken(token), signal),
        staleTime: 5 * 60 * 1000,
        refetchOnMount: "always",
    });
}

export function useDeleteMachine() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => deleteMachine(id, requireToken(token)),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: machineKeys.all }),
                queryClient.invalidateQueries({ queryKey: jobKeys.definitions }),
                queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
            ]);
        },
    });
}

export function useSaveMachine() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, values }: SaveMachineInput) =>
            id === null
                ? createMachine(values, requireToken(token))
                : updateMachine(id, values, requireToken(token)),
        onSuccess: async (machine) => {
            queryClient.setQueryData(machineKeys.detail(machine.id), machine);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: machineKeys.all }),
                queryClient.invalidateQueries({ queryKey: jobKeys.definitions }),
                queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
            ]);
        },
    });
}
