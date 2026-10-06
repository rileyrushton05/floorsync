"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/core/auth/AuthProvider";
import { API_BASE_URL, apiRequest } from "@/core/http/client";

/**
 * Live simulation notifications over the API's `/ws` socket (#148).
 *
 * The socket is only a *nudge*: Redis and WebSocket delivery may drop or repeat a
 * message, and the durable truth is the REST read. So this hook never hands the
 * screen a position — it reports that something changed (or that the socket has
 * just (re)connected and the screen may have missed something) and the screen
 * refetches. A gap, a duplicate and a reconnect therefore all heal the same way.
 *
 * Protocol: trade the bearer token for a one-time ticket, open the socket, send
 * `authenticate` within 5 s, `subscribe` to the simulation, then ping before the
 * server's 25 s idle timeout. The ticket is never put in the URL.
 */

export type LiveStatus = "connecting" | "live" | "offline";

const PROTOCOL_VERSION = 1;
const PING_MS = 15_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const CLOSE_FORBIDDEN = 4403;

interface TicketResponse {
    ticket: string;
}

function socketUrl(): string {
    return `${API_BASE_URL.replace(/^http/, "ws")}/ws`;
}

/**
 * Subscribe to one simulation. `onUpdate` fires for every snapshot and change
 * frame and `onStatus` whenever the connection state changes. Both are read
 * through refs so a new callback never reconnects the socket. The status is
 * reported rather than returned so the caller can use it to configure the very
 * query whose result supplies `simulationId`.
 */
export function useLiveUpdates(
    simulationId: string | null,
    onUpdate: () => void,
    onStatus: (status: LiveStatus) => void,
): void {
    const { token } = useAuth();
    const onUpdateRef = useRef(onUpdate);
    const onStatusRef = useRef(onStatus);

    useEffect(() => {
        onUpdateRef.current = onUpdate;
        onStatusRef.current = onStatus;
    });

    useEffect(() => {
        if (token === null || simulationId === null) return;

        let cancelled = false;
        let socket: WebSocket | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let pingTimer: ReturnType<typeof setInterval> | undefined;
        let attempt = 0;
        const abort = new AbortController();

        const scheduleRetry = () => {
            if (cancelled) return;
            onStatusRef.current("offline");
            // Doubling, capped, with jitter so every client does not retry together.
            const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt) * (0.5 + Math.random() / 2);
            attempt += 1;
            retryTimer = setTimeout(() => void connect(), delay);
        };

        const connect = async () => {
            if (cancelled) return;
            onStatusRef.current("connecting");
            let ticket: string;
            try {
                ({ ticket } = await apiRequest<TicketResponse>("/api/v1/live-updates/tickets", token, {
                    method: "POST",
                    signal: abort.signal,
                }));
            } catch {
                // 503 means live updates are down on the server; the screen keeps polling.
                scheduleRetry();
                return;
            }
            if (cancelled) return;

            const ws = new WebSocket(socketUrl());
            socket = ws;
            ws.onopen = () => {
                ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "authenticate", ticket }));
            };
            ws.onmessage = (event: MessageEvent<string>) => {
                let frame: { type?: string };
                try {
                    frame = JSON.parse(event.data) as { type?: string };
                } catch {
                    return;
                }
                if (frame.type === "authenticated") {
                    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "subscribe", simulation_id: simulationId }));
                    pingTimer = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "ping" }));
                        }
                    }, PING_MS);
                    attempt = 0;
                    onStatusRef.current("live");
                    // Anything that changed while we were disconnected is invisible to the socket.
                    onUpdateRef.current();
                } else if (frame.type === "simulation.snapshot" || frame.type === "simulation.changed") {
                    onUpdateRef.current();
                }
            };
            ws.onclose = (event) => {
                clearInterval(pingTimer);
                socket = null;
                // Refused for good: retrying cannot change the answer.
                if (event.code === CLOSE_FORBIDDEN) {
                    if (!cancelled) onStatusRef.current("offline");
                    return;
                }
                scheduleRetry();
            };
        };

        void connect();

        return () => {
            cancelled = true;
            abort.abort();
            clearTimeout(retryTimer);
            clearInterval(pingTimer);
            if (socket !== null) {
                socket.onclose = null;
                socket.close();
            }
        };
    }, [token, simulationId]);
}
