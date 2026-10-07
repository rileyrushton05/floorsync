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
 * A partial update. `password` replaces the current one outright. The machine
 * is not editable: an operator stays on the machine it was created for.
 */
export interface OperatorChanges {
    name?: string;
    username?: string;
    password?: string;
    active?: boolean;
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
