"use client";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";

/** Owns the browser cache of FastAPI resources for this app session. */
export function QueryProvider({ children }: { children: React.ReactNode }) {
    const [client] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        retry: 1,
                        refetchOnReconnect: true,
                    },
                },
            }),
    );

    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Cached manager data is scoped to the account that fetched it, never the browser tab. */
export function ClearQueryCacheOnAuthChange() {
    const { token } = useAuth();
    const queryClient = useQueryClient();
    const previousToken = useRef(token);

    useEffect(() => {
        if (previousToken.current !== token) queryClient.clear();
        previousToken.current = token;
    }, [queryClient, token]);

    return null;
}
