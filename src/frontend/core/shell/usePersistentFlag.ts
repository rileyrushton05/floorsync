"use client";

import { useCallback, useSyncExternalStore } from "react";

/* Session copy of every value, so changes still apply when storage throws
   (private windows, blocked site data) — they just won't outlive the tab. */
const memory = new Map<string, string | null>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function read(key: string): string | null {
    if (memory.has(key)) return memory.get(key) ?? null;
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string | null) {
    memory.set(key, value);
    try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
    } catch {
        // Storage unavailable; the in-memory copy still carries the change.
    }
    listeners.forEach((listener) => listener());
}

/* The server render (and the first client render) always see null, so a
   remembered value applies straight after hydration without a mismatch. */
function usePersistentString(key: string): [string | null, (value: string | null) => void] {
    const value = useSyncExternalStore(subscribe, () => read(key), () => null);
    const set = useCallback((next: string | null) => write(key, next), [key]);
    return [value, set];
}

/** A boolean remembered in this browser under `key`, false until set. */
export function usePersistentFlag(key: string): [boolean, (value: boolean) => void] {
    const [raw, setRaw] = usePersistentString(key);
    const set = useCallback((next: boolean) => setRaw(next ? "1" : null), [setRaw]);
    return [raw === "1", set];
}

/** A number remembered in this browser under `key`; null until set, and
    setting null forgets it. */
export function usePersistentNumber(key: string): [number | null, (value: number | null) => void] {
    const [raw, setRaw] = usePersistentString(key);
    const set = useCallback((next: number | null) => setRaw(next === null ? null : String(next)), [setRaw]);
    const parsed = raw === null ? NaN : Number(raw);
    return [Number.isFinite(parsed) ? parsed : null, set];
}
