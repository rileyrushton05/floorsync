"use client";

import { useAuth } from "@/core/auth/AuthProvider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchOperators, updateOperator, type OperatorChanges } from "./api";
import { operatorKeys } from "./keys";

function requireToken(token: string | null): string {
    if (token === null) throw new Error("Sign in again before changing operator accounts.");
    return token;
}

export function useOperators() {
    const { token } = useAuth();
    return useQuery({
        queryKey: operatorKeys.all,
        enabled: token !== null,
        queryFn: ({ signal }) => fetchOperators(requireToken(token), signal),
        refetchOnMount: "always",
    });
}

export function useUpdateOperator() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, changes }: { id: string; changes: OperatorChanges }) =>
            updateOperator(id, changes, requireToken(token)),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: operatorKeys.all }),
    });
}

