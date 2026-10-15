"use client";

import { useAuth } from "@/core/auth/AuthProvider";
import { jobKeys } from "@/features/jobs/data/keys";
import { machineKeys } from "@/features/machines/data/keys";
import { operatorKeys } from "@/features/operators/data/keys";
import { scheduleKeys } from "@/features/schedules/data/keys";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { importFile } from "./api";

function requireToken(token: string | null): string {
    if (token === null) throw new Error("Sign in again before importing.");
    return token;
}

/**
 * Check a file without keeping anything. A mutation rather than a query: it is
 * a POST about a file the manager just picked, and nothing should cache it.
 */
export function useImportDryRun() {
    const { token } = useAuth();
    return useMutation({
        mutationFn: (file: File) => importFile(file, true, requireToken(token)),
    });
}

export function useImportFile() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (file: File) => importFile(file, false, requireToken(token)),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: jobKeys.definitions }),
                queryClient.invalidateQueries({ queryKey: jobKeys.all }),
                queryClient.invalidateQueries({ queryKey: jobKeys.dependenciesAll }),
                // Machines and their categories: an import can create both.
                queryClient.invalidateQueries({ queryKey: machineKeys.all }),
                // Every machine an import creates gets an operator login.
                queryClient.invalidateQueries({ queryKey: operatorKeys.all }),
                queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
            ]);
        },
    });
}
