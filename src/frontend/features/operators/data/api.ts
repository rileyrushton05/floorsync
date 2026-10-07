import { apiRequest } from "@/core/http/client";

/** An operator login as a manager sees it. The password never leaves the API. */
export interface OperatorAccount {
    id: string;
    name: string;
    username: string;
    active: boolean;
    machine_id: string;
    machine_name: string;
    last_authenticated_at: string | null;
    created_at: string;
}

/**
 * A partial update. `password` replaces the current one outright; `machine_id`
 * must be another operator's machine, and the two operators swap.
 */
export interface OperatorChanges {
    name?: string;
    username?: string;
    password?: string;
    active?: boolean;
    machine_id?: string;
}

export function fetchOperators(token: string, signal?: AbortSignal): Promise<OperatorAccount[]> {
    return apiRequest<OperatorAccount[]>("/api/v1/operators", token, { signal });
}

export function updateOperator(userId: string, changes: OperatorChanges, token: string): Promise<OperatorAccount> {
    return apiRequest<OperatorAccount>(`/api/v1/operators/${encodeURIComponent(userId)}`, token, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
    });
}
