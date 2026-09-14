"use client";

import { useAuth } from "@/app/_components/AuthProvider";
import { fetchEveryPage } from "@/app/_lib/pagination";
import { queryKeys } from "@/app/_lib/query-keys";
import {
    createMachine,
    fetchMachineCategories,
    fetchMachines,
    updateMachine,
    type MachineInput,
} from "@/app/_lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
        queryKey: queryKeys.machines.all,
        enabled: token !== null,
        queryFn: ({ signal }) =>
            fetchEveryPage((cursor, pageSignal) => fetchMachines(requireToken(token), 100, cursor, pageSignal), signal),
        refetchOnMount: "always",
    });
}

export function useMachineCategories() {
    const { token } = useAuth();
    return useQuery({
        queryKey: queryKeys.machines.categories,
        enabled: token !== null,
        queryFn: ({ signal }) => fetchMachineCategories(requireToken(token), signal),
        staleTime: 5 * 60 * 1000,
        refetchOnMount: "always",
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
            queryClient.setQueryData(queryKeys.machines.detail(machine.id), machine);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.machines.all }),
                queryClient.invalidateQueries({ queryKey: queryKeys.jobDefinitions.all }),
                queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all }),
            ]);
        },
    });
}
