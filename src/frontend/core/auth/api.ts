import { apiRequest } from "@/core/http/client";

export interface AccessToken {
    access_token: string;
    token_type: string;
    expires_in: number;
}

export interface CurrentUser {
    id: string;
    name: string;
    role: "manager" | "operator";
    machine_id: string | null;
}

export function authenticate(username: string, password: string): Promise<AccessToken> {
    return apiRequest<AccessToken>("/api/v1/auth/token", null, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username, password }).toString(),
    });
}

export function fetchCurrentUser(token: string, signal?: AbortSignal): Promise<CurrentUser> {
    return apiRequest<CurrentUser>("/api/v1/auth/me", token, { signal });
}
