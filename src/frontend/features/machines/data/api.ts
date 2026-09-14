import { apiRequest } from "@/core/http/client";
import type { CursorPage } from "@/core/http/contracts";

export interface MachineSummary {
    id: string;
    name: string;
    category_id: string | null;
    salary: string | null;
    active: boolean;
    created_at: string;
    updated_at: string;
}

export interface MachineCategory {
    id: string;
    name: string;
    created_at: string;
    updated_at: string;
}

export interface MachineInput {
    name: string;
    category_id?: string | null;
    salary?: string | null;
    active?: boolean;
}

export function fetchMachines(token: string, limit = 100, cursor?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return apiRequest<CursorPage<MachineSummary>>(`/api/v1/machines?${query.toString()}`, token, { signal });
}

export function fetchMachineCategories(token: string, signal?: AbortSignal): Promise<MachineCategory[]> {
    return apiRequest<MachineCategory[]>("/api/v1/categories", token, { signal });
}

export function createMachine(input: MachineInput, token: string): Promise<MachineSummary> {
    return apiRequest<MachineSummary>("/api/v1/machines", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

export function updateMachine(machineId: string, input: Partial<MachineInput>, token: string): Promise<MachineSummary> {
    return apiRequest<MachineSummary>(`/api/v1/machines/${encodeURIComponent(machineId)}`, token, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}
